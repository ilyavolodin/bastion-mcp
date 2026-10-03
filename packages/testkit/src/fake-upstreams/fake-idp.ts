import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, jwtVerify, SignJWT } from 'jose';

/** A local OIDC IdP built with jose + node:http (login, refresh, RFC 8693 exchange, jwt-bearer OBO). */
export type FakeIdpBehavior = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  groups: string[];
  /** Extra claims put into the ID token. */
  extraClaims: Record<string, unknown>;
  issParameter: boolean;
  /** Overrides the `iss` sent in the authorization response. */
  issParameterValue: string | null;
  emitIdTokenOnRefresh: boolean;
  /** When set, token exchange and OBO calls fail with this error description. */
  refuseExchange: string | null;
  refuseRefresh: boolean;
  /** When false a refresh response carries no new refresh token. */
  rotateRefreshToken: boolean;
  accessTokenTtl: number;
  idJagTtl: number;
};

export type IdpRecordedRequest = {
  path: string;
  params: Record<string, string>;
  auth: string | undefined;
};

export type FakeIdp = {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  behavior: FakeIdpBehavior;
  requests: IdpRecordedRequest[];
  publicJwk: JWK;
  /** Signs an arbitrary JWT with the IdP key (ID-JAG and ID token fixtures). */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  /** Drives the authorization endpoint like a browser and returns the callback query string. */
  authorize(url: string): Promise<string>;
  rotateKey(): Promise<void>;
  close(): Promise<void>;
};

const parseForm = async (req: IncomingMessage): Promise<Record<string, string>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export const startFakeIdp = async (overrides: Partial<FakeIdpBehavior> = {}): Promise<FakeIdp> => {
  let keys = await generateKeyPair('ES256', { extractable: true });
  let kid = 'idp-key-1';
  let publicJwk: JWK = { ...(await exportJWK(keys.publicKey)), kid, alg: 'ES256', use: 'sig' };
  const behavior: FakeIdpBehavior = {
    sub: 'idp-user-1',
    email: 'ada@acme.example',
    emailVerified: true,
    name: 'Ada Lovelace',
    groups: ['eng', 'bastion-admins'],
    extraClaims: {},
    issParameter: true,
    issParameterValue: null,
    emitIdTokenOnRefresh: true,
    refuseExchange: null,
    refuseRefresh: false,
    rotateRefreshToken: true,
    accessTokenTtl: 3600,
    idJagTtl: 300,
    ...overrides,
  };
  const clientId = 'bastion-at-idp';
  const clientSecret = 'idp-client-secret';
  const requests: IdpRecordedRequest[] = [];
  const codes = new Map<
    string,
    { nonce: string | undefined; challenge: string; redirect: string; scope: string }
  >();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Map<string, string>();
  let counter = 0;
  let issuer = '';

  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid, ...header }).sign(keys.privateKey);

  const idToken = (_scope: string, nonce: string | undefined, audience = clientId) =>
    sign({
      iss: issuer,
      sub: behavior.sub,
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      email: behavior.email,
      email_verified: behavior.emailVerified,
      name: behavior.name,
      groups: behavior.groups,
      ...(nonce ? { nonce } : {}),
      ...behavior.extraClaims,
    });

  const issueTokens = async (scope: string, nonce: string | undefined, withId: boolean) => {
    counter += 1;
    const access = `idp-at-${counter}`;
    accessTokens.set(access, behavior.sub);
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: behavior.accessTokenTtl,
      scope,
    };
    if (scope.split(' ').includes('offline_access')) {
      const refresh = `idp-rt-${counter}`;
      refreshTokens.set(refresh, scope);
      body.refresh_token = refresh;
    }
    if (withId) body.id_token = await idToken(scope, nonce);
    return body;
  };

  const authenticate = (req: IncomingMessage, params: Record<string, string>): boolean => {
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      return (
        decodeURIComponent(id ?? '') === clientId &&
        decodeURIComponent(secret ?? '') === clientSecret
      );
    }
    return params.client_id === clientId && params.client_secret === clientSecret;
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse) => {
    const params = await parseForm(req);
    requests.push({ path: '/token', params, auth: req.headers.authorization });
    if (!authenticate(req, params)) return json(res, 401, { error: 'invalid_client' });
    switch (params.grant_type) {
      case 'authorization_code': {
        const entry = codes.get(params.code ?? '');
        codes.delete(params.code ?? '');
        if (!entry || entry.redirect !== params.redirect_uri)
          return json(res, 400, { error: 'invalid_grant' });
        const challenge = createHash('sha256')
          .update(params.code_verifier ?? '')
          .digest('base64url');
        if (challenge !== entry.challenge)
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        return json(res, 200, await issueTokens(entry.scope, entry.nonce, true));
      }
      case 'refresh_token': {
        const scope = refreshTokens.get(params.refresh_token ?? '');
        if (!scope || behavior.refuseRefresh) {
          return json(res, 400, {
            error: 'invalid_grant',
            error_description: 'refresh token revoked',
          });
        }
        const body = await issueTokens(scope, undefined, behavior.emitIdTokenOnRefresh);
        if (!behavior.rotateRefreshToken) delete body.refresh_token;
        return json(res, 200, body);
      }
      case 'urn:ietf:params:oauth:grant-type:token-exchange': {
        if (behavior.refuseExchange) {
          return json(res, 400, {
            error: 'access_denied',
            error_description: behavior.refuseExchange,
          });
        }
        const type = params.requested_token_type;
        if (type === 'urn:ietf:params:oauth:token-type:id-jag') {
          try {
            const keyset = createLocalJWKSet({ keys: [publicJwk] });
            await jwtVerify(params.subject_token ?? '', keyset, { issuer });
          } catch {
            return json(res, 400, {
              error: 'invalid_request',
              error_description: 'bad subject_token',
            });
          }
          const now = Math.floor(Date.now() / 1000);
          const jag = await sign(
            {
              iss: issuer,
              sub: behavior.sub,
              aud: params.audience,
              resource: params.resource,
              client_id: params.client_id ?? clientId,
              jti: randomUUID(),
              iat: now,
              exp: now + behavior.idJagTtl,
              scope: params.scope,
            },
            { typ: 'oauth-id-jag+jwt' },
          );
          return json(res, 200, {
            access_token: jag,
            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
            token_type: 'N_A',
            expires_in: behavior.idJagTtl,
          });
        }
        if (!accessTokens.has(params.subject_token ?? '')) {
          return json(res, 400, {
            error: 'invalid_request',
            error_description: 'unknown subject_token',
          });
        }
        return json(res, 200, {
          access_token: `exchanged-for-${params.audience}-${++counter}`,
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 1800,
          scope: params.scope,
        });
      }
      case 'urn:ietf:params:oauth:grant-type:jwt-bearer': {
        if (behavior.refuseExchange) {
          return json(res, 400, {
            error: 'invalid_grant',
            error_description: behavior.refuseExchange,
          });
        }
        return json(res, 200, {
          access_token: `obo-${++counter}`,
          token_type: 'Bearer',
          expires_in: 1800,
          scope: params.scope,
        });
      }
      default:
        return json(res, 400, { error: 'unsupported_grant_type' });
    }
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const run = async () => {
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['ES256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          authorization_response_iss_parameter_supported: behavior.issParameter,
        });
      }
      if (url.pathname === '/jwks') return json(res, 200, { keys: [publicJwk] });
      if (url.pathname === '/authorize') {
        const q = Object.fromEntries(url.searchParams);
        requests.push({ path: '/authorize', params: q, auth: undefined });
        const code = `code-${++counter}`;
        codes.set(code, {
          nonce: q.nonce,
          challenge: q.code_challenge ?? '',
          redirect: q.redirect_uri ?? '',
          scope: q.scope ?? '',
        });
        const back = new URL(q.redirect_uri ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.state ?? '');
        if (behavior.issParameter)
          back.searchParams.set('iss', behavior.issParameterValue ?? issuer);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') return handleToken(req, res);
      res.writeHead(404);
      res.end();
    };
    run().catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId,
    clientSecret,
    behavior,
    requests,
    get publicJwk() {
      return publicJwk;
    },
    sign,
    async authorize(url) {
      const response = await fetch(url, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (!location) throw new Error(`authorize returned ${response.status}`);
      return new URL(location).search.slice(1);
    },
    async rotateKey() {
      keys = await generateKeyPair('ES256', { extractable: true });
      kid = `idp-key-${++counter}`;
      publicJwk = { ...(await exportJWK(keys.publicKey)), kid, alg: 'ES256', use: 'sig' };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  } as FakeIdp;
};
