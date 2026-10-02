import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Keyring } from '@bastion-mcp/core';
import Provider, { type Configuration, errors, interactionPolicy } from 'oidc-provider';
import {
  ACCESS_TOKEN_TTL_S,
  BASTION_SCOPES,
  CONSENT_TTL_S,
  CREDENTIAL_CLIENT_ID,
  DEVICE_CODE_GRANT,
  ENTERPRISE_MANAGED_EXTENSION,
  REFRESH_ABSOLUTE_TTL_S,
  REFRESH_IDLE_TTL_S,
} from '../constants';
import {
  type Clock,
  type FetchFn,
  type OAuthClientPolicyStore,
  type OidcModelStore,
  type PrincipalDirectory,
  type RedisLike,
  type RegistrationSettingsSource,
  type SigningKeySource,
  systemClock,
} from '../ports';
import { isAllowedResource, issuerFor, mcpResource } from '../urls';
import { createOidcAdapterClass } from './adapter';
import { type PreparedClient, type PreRegisterInput, prepareClient } from './clients';
import { type IdJagVerifier, registerJwtBearerGrant } from './id-jag-grant';
import { createInteractionApi, type InteractionApi } from './interaction';
import { loadAsJwks } from './keys';
import { runtime } from './provider-types';
import {
  defaultClientIp,
  gateRegistration,
  isCimdHostAllowed,
  isRedirectUriAllowed,
} from './registration';
import { resourceServerInfo } from './resource-server';

export type AuthorizationServerDeps = {
  /** Public host, for example `bastion.example.com`; the issuer is `https://<host>/oauth`. */
  host: string;
  orgName: string;
  models: OidcModelStore;
  signingKeys: SigningKeySource;
  clientPolicies: OAuthClientPolicyStore;
  registration: RegistrationSettingsSource;
  principals: PrincipalDirectory;
  redis: RedisLike;
  /** Verifies ID-JAGs for the jwt-bearer grant (9.4); the grant is not registered without it. */
  idJag?: IdJagVerifier;
  /** Outbound fetch for CIMD documents; wrap with `createSafeFetch`. */
  fetch?: FetchFn;
  clock?: Clock;
  /** Secrets that sign oidc-provider cookies (rotate by prepending). */
  cookieKeys: string[];
  /** Seals `client_secret` inside `oidc_models` payloads. */
  clientSecretKeyring?: Keyring;
  clientIp?: (req: IncomingMessage) => string;
  /** Where the ui role serves login and consent pages; default `/oauth/interaction`. */
  interactionPath?: string;
  /** Receives unexpected provider failures (log them; never include token values). */
  onServerError?: (error: Error) => void;
  /** Advertise the Enterprise-Managed Authorization extension in AS metadata (9.4). */
  enterpriseManaged?: boolean;
};

export type AuthorizationServer = {
  readonly issuer: string;
  /** Node request listener for `/oauth/*` and the RFC 8414 path-form metadata. Other paths get 404. */
  listener: RequestListener;
  /** The current oidc-provider instance (changes after `reload`). */
  provider(): Provider;
  /** Rebuilds the provider with the current signing keys (call on `bastion:config` key events). */
  reload(): Promise<void>;
  interactions: InteractionApi;
  /** Persists an admin pre-registered or service-account client (17.2). */
  preRegisterClient(input: PreRegisterInput): Promise<PreparedClient>;
};

const CIMD_ACK = 'draft-02';

export const createAuthorizationServer = async (
  deps: AuthorizationServerDeps,
): Promise<AuthorizationServer> => {
  const clock = deps.clock ?? systemClock;
  const issuer = issuerFor(deps.host);
  const interactionPath = deps.interactionPath ?? '/oauth/interaction';
  const Adapter = createOidcAdapterClass({
    store: deps.models,
    clock,
    policies: deps.clientPolicies,
    ...(deps.clientSecretKeyring ? { secretKeyring: deps.clientSecretKeyring } : {}),
  });

  const build = async (): Promise<Provider> => {
    const jwks = await loadAsJwks(deps.signingKeys, clock.now());
    const features = {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      introspection: { enabled: false },
      revocation: { enabled: true },
      clientCredentials: { enabled: true },
      deviceFlow: { enabled: true },
      registration: { enabled: true, initialAccessToken: false },
      registrationManagement: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async (_ctx: unknown, _client: unknown, oneOf?: string | string[]) =>
          oneOf ?? mcpResource(deps.host),
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx: unknown, resource: string) => {
          if (!isAllowedResource(deps.host, resource)) throw new errors.InvalidTarget();
          return resourceServerInfo(deps.host, resource);
        },
      },
      clientIdMetadataDocument: {
        enabled: true,
        ack: CIMD_ACK,
        allowFetch: async (_ctx: unknown, clientId: string) => {
          const settings = await deps.registration.get();
          return settings.cimd && isCimdHostAllowed(settings, clientId);
        },
        allowClient: async (
          _ctx: unknown,
          client: { clientId: string; redirectUris?: string[] },
        ) => {
          const policy = await deps.clientPolicies.get(client.clientId);
          if (policy?.blocked) return false;
          return (client.redirectUris ?? []).every(isRedirectUriAllowed);
        },
        cacheDuration: { min: 30, max: 3600 },
      },
    };

    const config: Configuration = {
      adapter: Adapter,
      jwks: { keys: jwks.keys as never },
      cookies: { keys: deps.cookieKeys },
      scopes: [...BASTION_SCOPES],
      responseTypes: ['code'],
      subjectTypes: ['public'],
      claims: {},
      clientAuthMethods: ['none', 'client_secret_basic', 'private_key_jwt'],
      clientDefaults: {
        grant_types: ['authorization_code'],
        id_token_signed_response_alg: 'ES256',
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      enabledJWA: {
        clientAuthSigningAlgValues: ['ES256', 'RS256', 'EdDSA'],
        idTokenSigningAlgValues: ['ES256'],
      },
      pkce: { required: () => true },
      discovery: deps.enterpriseManaged
        ? ({ extensions_supported: [ENTERPRISE_MANAGED_EXTENSION] } as never)
        : {},
      fetch: deps.fetch ?? ((url, options) => globalThis.fetch(url, options)),
      clients: [
        {
          client_id: CREDENTIAL_CLIENT_ID,
          client_name: 'Bastion credential helper',
          token_endpoint_auth_method: 'none',
          grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
          response_types: [],
          scope: 'plugins:read offline_access',
        },
      ],
      features: features as unknown as Configuration['features'],
      ttl: {
        AccessToken: (_ctx, token) => token.resourceServer?.accessTokenTTL ?? ACCESS_TOKEN_TTL_S,
        ClientCredentials: (_ctx, token) =>
          token.resourceServer?.accessTokenTTL ?? ACCESS_TOKEN_TTL_S,
        AuthorizationCode: 60,
        DeviceCode: 600,
        IdToken: 600,
        Grant: CONSENT_TTL_S,
        Interaction: 3600,
        Session: 12 * 3600,
        // 7-day idle, 30-day absolute from the first issue (`iiat`).
        RefreshToken: (_ctx, token) => {
          const nowS = Math.floor(clock.now() / 1000);
          const age = nowS - ((token as unknown as { iiat?: number }).iiat ?? nowS);
          return Math.max(1, Math.min(REFRESH_IDLE_TTL_S, REFRESH_ABSOLUTE_TTL_S - age));
        },
      },
      issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      expiresWithSession: async () => false,
      rotateRefreshToken: (ctx) => {
        const refresh = ctx.oidc.entities.RefreshToken;
        return !refresh || refresh.totalLifetime() < REFRESH_ABSOLUTE_TTL_S;
      },
      findAccount: async (_ctx, sub) =>
        (await deps.principals.isUserActive(sub))
          ? { accountId: sub, claims: async () => ({ sub }) }
          : undefined,
      loadExistingGrant: async (ctx) => {
        const oidc = ctx.oidc;
        const clientId = oidc.client?.clientId;
        if (!clientId) return undefined;
        const grantId = oidc.result?.consent?.grantId ?? oidc.session?.grantIdFor(clientId);
        if (grantId) {
          const found = await oidc.provider.Grant.find(grantId);
          if (found) return found;
        }
        const policy = await deps.clientPolicies.get(clientId);
        const accountId = oidc.session?.accountId;
        if ((policy?.preApproved || clientId === CREDENTIAL_CLIENT_ID) && accountId) {
          const grant = new (runtime(oidc.provider).Grant)({ clientId, accountId });
          const requested = [...oidc.requestParamScopes];
          const known = requested.filter((s) => (BASTION_SCOPES as readonly string[]).includes(s));
          if (known.length > 0) grant.addOIDCScope(known.join(' '));
          for (const [resource, server] of Object.entries(oidc.resourceServers ?? {})) {
            const allowed = requested.filter((s) => server.scope.split(' ').includes(s));
            if (allowed.length > 0) grant.addResourceScope(resource, allowed.join(' '));
          }
          await grant.save(CONSENT_TTL_S);
          return grant as never;
        }
        return undefined;
      },
      interactions: {
        url: async (_ctx, interaction) => `${interactionPath}/${interaction.uid}`,
        policy: (() => {
          const policy = interactionPolicy.base();
          // Remembered consent (9.3): native clients use the same Grant lookup, no forced prompt.
          policy.get('consent')?.checks.remove('native_client_prompt');
          return policy;
        })(),
      },
      formats: {
        customizers: {
          jwt: async (
            _ctx: unknown,
            token: { kind?: string; clientId?: string },
            jwt: { payload: Record<string, unknown> },
          ) => {
            if (token.kind === 'ClientCredentials') {
              const account = token.clientId
                ? await deps.principals.serviceAccountForClient(token.clientId)
                : null;
              if (!account) throw new errors.UnauthorizedClient('client is not a service account');
              jwt.payload.sub = account.id;
              jwt.payload['bastion:pt'] = 'service';
            } else {
              jwt.payload['bastion:pt'] = 'user';
            }
          },
        },
      } as never,
    };

    const provider = new Provider(issuer, config);
    provider.proxy = true;
    if (deps.onServerError) {
      const report = deps.onServerError;
      provider.on('server_error', (_ctx: unknown, error: Error) => report(error));
    }
    if (deps.idJag) {
      registerJwtBearerGrant(provider, {
        host: deps.host,
        issuer,
        verifier: deps.idJag,
        principals: deps.principals,
      });
    }
    return provider;
  };

  let current = await build();

  const listener: RequestListener = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    let path = url.pathname;
    if (path === '/.well-known/oauth-authorization-server/oauth') {
      path = '/.well-known/openid-configuration';
    } else if (path === '/oauth' || path.startsWith('/oauth/')) {
      path = path.slice('/oauth'.length) || '/';
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    try {
      if (req.method === 'POST' && path === '/reg') {
        const answered = await gateRegistration(req, res, {
          settings: deps.registration,
          redis: deps.redis,
          clientIp: deps.clientIp ?? defaultClientIp,
        });
        if (answered) return;
      }
      // oidc-provider derives its mount path from `originalUrl` versus `url`.
      (req as IncomingMessage & { originalUrl?: string }).originalUrl =
        `/oauth${path}${url.search}`;
      req.url = `${path}${url.search}`;
      current.callback()(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"server_error"}');
    }
  };

  return {
    issuer,
    listener,
    provider: () => current,
    async reload() {
      current = await build();
    },
    interactions: createInteractionApi(() => current),
    async preRegisterClient(input) {
      const prepared = prepareClient(input);
      await new Adapter('Client').upsert(prepared.clientId, prepared.payload as never, 0);
      return prepared;
    },
  };
};
