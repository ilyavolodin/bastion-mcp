import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A fake upstream MCP server with its own authorization server (RFC 9728, 8414, 7591, 7009, 9207). */
export type FakeUpstreamBehavior = {
  advertiseS256: boolean;
  advertiseCimd: boolean;
  registration: boolean;
  issParameter: boolean;
  issParameterValue: string | null;
  /** When false the 401 carries no resource_metadata and only the well-known paths work. */
  prmInHeader: boolean;
  prmAvailable: boolean;
  grantTypes: string[] | null;
  revocation: boolean;
  expiresIn: number;
  /** `invalid_grant` -> 400, `server_error` -> 500, null -> ok */
  refreshFailure: 'invalid_grant' | 'server_error' | null;
  /** jwt-bearer grant refusal description. */
  jwtBearerRefusal: string | null;
  /** Scope the MCP endpoint demands; tokens lacking it get 403 insufficient_scope. */
  requiredScope: string | null;
  /** Scope granted at the token endpoint regardless of the request (null: echo the request). */
  grantScope: string | null;
  authMethods: string[];
};

export type UpstreamRequest = {
  path: string;
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
};

export type FakeUpstream = {
  origin: string;
  mcpUrl: string;
  behavior: FakeUpstreamBehavior;
  requests: UpstreamRequest[];
  registrations: Record<string, unknown>[];
  revoked: string[];
  /** Drives /authorize like a browser and returns the callback query. */
  authorize(url: string): Promise<string>;
  callMcp(token: string | null): Promise<Response>;
  close(): Promise<void>;
};

const read = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};
const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export const startFakeUpstream = async (
  overrides: Partial<FakeUpstreamBehavior> = {},
): Promise<FakeUpstream> => {
  const behavior: FakeUpstreamBehavior = {
    advertiseS256: true,
    advertiseCimd: false,
    registration: true,
    issParameter: true,
    issParameterValue: null,
    prmInHeader: true,
    prmAvailable: true,
    grantTypes: null,
    revocation: true,
    expiresIn: 3600,
    refreshFailure: null,
    jwtBearerRefusal: null,
    requiredScope: null,
    grantScope: null,
    authMethods: ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none'],
    ...overrides,
  };
  const requests: UpstreamRequest[] = [];
  const registrations: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  const codes = new Map<string, { challenge: string; redirect: string; scope: string }>();
  const tokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  let n = 0;
  let origin = '';

  const issue = (scope: string) => {
    n += 1;
    const granted = behavior.grantScope ?? scope;
    const access = `up-at-${n}`;
    tokens.set(access, granted);
    const refresh = `up-rt-${n}`;
    refreshTokens.set(refresh, granted);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: behavior.expiresIn,
      refresh_token: refresh,
      scope: granted,
    };
  };

  const metadata = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    jwks_uri: `${origin}/jwks`,
    ...(behavior.registration ? { registration_endpoint: `${origin}/register` } : {}),
    ...(behavior.revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
    response_types_supported: ['code'],
    code_challenge_methods_supported: behavior.advertiseS256 ? ['S256'] : ['plain'],
    token_endpoint_auth_methods_supported: behavior.authMethods,
    authorization_response_iss_parameter_supported: behavior.issParameter,
    client_id_metadata_document_supported: behavior.advertiseCimd,
    ...(behavior.grantTypes ? { grant_types_supported: behavior.grantTypes } : {}),
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    const headers = { authorization: req.headers.authorization } as Record<
      string,
      string | undefined
    >;
    if (url.pathname === '/mcp' && req.method === 'POST') {
      await read(req);
      requests.push({ path: '/mcp', params: {}, headers });
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const granted = bearer ? tokens.get(bearer) : undefined;
      if (!granted) {
        return json(
          res,
          401,
          { error: 'unauthorized' },
          behavior.prmInHeader
            ? {
                'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
              }
            : { 'www-authenticate': 'Bearer' },
        );
      }
      if (behavior.requiredScope && !granted.split(' ').includes(behavior.requiredScope)) {
        return json(
          res,
          403,
          { error: 'insufficient_scope' },
          {
            'www-authenticate': `Bearer error="insufficient_scope", scope="${[...new Set([...granted.split(' '), behavior.requiredScope])].join(' ')}"`,
          },
        );
      }
      return json(res, 200, { jsonrpc: '2.0', id: 0, result: {} });
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (!behavior.prmAvailable) return json(res, 404, {});
      return json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['read', 'write'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, metadata());
    if (url.pathname === '/jwks') return json(res, 200, { keys: [] });
    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      requests.push({ path: '/authorize', params: q, headers });
      const code = `up-code-${++n}`;
      codes.set(code, {
        challenge: q.code_challenge ?? '',
        redirect: q.redirect_uri ?? '',
        scope: q.scope ?? '',
      });
      const back = new URL(q.redirect_uri ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state ?? '');
      if (behavior.issParameter) back.searchParams.set('iss', behavior.issParameterValue ?? origin);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await read(req)) as Record<string, unknown>;
      registrations.push(body);
      requests.push({ path: '/register', params: {}, headers });
      const method = String(body.token_endpoint_auth_method);
      return json(res, 201, {
        client_id: `dcr-client-${registrations.length}`,
        ...(method === 'none' ? {} : { client_secret: `dcr-secret-${registrations.length}` }),
        token_endpoint_auth_method: method,
      });
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(await read(req)));
      requests.push({ path: '/revoke', params, headers });
      revoked.push(params.token ?? '');
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(await read(req)));
      requests.push({ path: '/token', params, headers });
      switch (params.grant_type) {
        case 'authorization_code': {
          const entry = codes.get(params.code ?? '');
          codes.delete(params.code ?? '');
          if (!entry || entry.redirect !== params.redirect_uri)
            return json(res, 400, { error: 'invalid_grant' });
          if (
            createHash('sha256')
              .update(params.code_verifier ?? '')
              .digest('base64url') !== entry.challenge
          ) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE failed' });
          }
          return json(res, 200, issue(entry.scope));
        }
        case 'refresh_token': {
          if (behavior.refreshFailure === 'server_error')
            return json(res, 500, { error: 'server_error' });
          const scope = refreshTokens.get(params.refresh_token ?? '');
          if (behavior.refreshFailure === 'invalid_grant' || !scope)
            return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, issue(scope));
        }
        case 'urn:ietf:params:oauth:grant-type:jwt-bearer': {
          if (behavior.jwtBearerRefusal) {
            return json(res, 400, {
              error: 'invalid_grant',
              error_description: behavior.jwtBearerRefusal,
            });
          }
          return json(res, 200, { ...issue(params.scope ?? 'read'), refresh_token: undefined });
        }
        default:
          return json(res, 400, { error: 'unsupported_grant_type' });
      }
    }
    res.writeHead(404);
    res.end();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    behavior,
    requests,
    registrations,
    revoked,
    async authorize(url) {
      const response = await fetch(url, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (!location) throw new Error(`authorize returned ${response.status}`);
      return new URL(location).search.slice(1);
    },
    callMcp: (token) =>
      fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: '{}',
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
