/**
 * Identity, OAuth and credential services (9.1 to 9.7), wired from the db repositories and the vault. Everything here
 * is composition: the behaviour lives in `@bastion-mcp/auth`.
 */
import { createHmac } from 'node:crypto';
import {
  createAuthorizationServer,
  createSafeFetch,
  type DeactivationAction,
  type DeactivationExecutor,
  executeDeactivation,
  IdpClients,
  IdpLogin,
  IdpMintedTokens,
  IdpTokenVault,
  type InstallationLookup,
  type OAuthInstallation,
  PatService,
  type PrincipalStore,
  planDeactivation,
  type RevocationEvent,
  type RevocationStore,
  ScimService,
  type SecretResolver,
  SessionService,
  TokenVerifier,
  UpstreamCredentialResolver,
  UpstreamOAuthBroker,
} from '@bastion-mcp/auth';
import {
  type Keyring,
  REDIS_CHANNELS,
  redisKeys,
  resolveTemplate,
  type TemplateContext,
  TTL,
} from '@bastion-mcp/core';
import {
  buildStateKeyring,
  decryptSecret,
  type KeyStore,
  rotateKeyring,
} from '@bastion-mcp/secrets';
import type { AuthServices } from '../contracts';
import { bastionProviderPages } from '../http/pages/provider-pages';
import type { Infra } from '../infra';
import { KEY_REFRESH_MS, LAST_USED_FLUSH_MS } from '../timing';
import { watchConfig } from './config-watch';
import { authRedis } from './redis';

const KEY_TOPICS = new Set(['signing_keys', 'state_keys', 'keys']);

/** Redis `revoked:{principalId}` watermark (9.1) plus the `bastion:revoke` channel (16.3). */
export const createRevocationStore = (infra: Infra): RevocationStore => ({
  async getWatermark(principalId) {
    const raw = await infra.redis.get(redisKeys.revoked(principalId));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  },
  async setWatermark(principalId, epochSeconds) {
    await infra.redis.set(redisKeys.revoked(principalId), String(epochSeconds), 'EX', TTL.revoked);
  },
  async publish(event: RevocationEvent) {
    await infra.redis.publish(REDIS_CHANNELS.revoke, JSON.stringify(event));
  },
});

/** Creates the first key of each purpose when none exists (the boot seed does this too; both are idempotent enough). */
const ensureKeys = async (keyStore: KeyStore): Promise<void> => {
  if ((await keyStore.listSigningKeys('as')).length === 0) await rotateKeyring(keyStore, 'as');
  if ((await keyStore.listSigningKeys('upstream-client')).length === 0) {
    await rotateKeyring(keyStore, 'upstream-client');
  }
  if ((await keyStore.listStateKeys()).length === 0) await rotateKeyring(keyStore, 'state');
};

const loadStateKeyring = async (keyStore: KeyStore): Promise<Keyring> =>
  buildStateKeyring(await keyStore.listStateKeys(), new Date());

/** Cookie signing keys derived from the internal secret: identical on every replica (22.3). */
export const deriveCookieKeys = (secret: string, previous?: string): string[] =>
  [secret, previous]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => createHmac('sha256', s).update('bastion-oidc-cookies-v1').digest('hex'));

export const createInstallationLookup = (infra: Infra): InstallationLookup => {
  const { repos } = infra;
  return {
    async get(installationId): Promise<OAuthInstallation | null> {
      const row = await repos.installationRegistry?.get(installationId);
      if (!row) return null;
      const auth = row.spec.auth;
      if (auth.mode !== 'oauth') return null;
      const context: TemplateContext = { var: row.variables };
      let upstreamUrl = '';
      if (row.spec.type === 'remote') {
        try {
          upstreamUrl = resolveTemplate(row.spec.url, context);
        } catch {
          upstreamUrl = row.spec.url;
        }
      }
      return {
        id: row.installationId,
        name: row.slug,
        kind: row.spec.type === 'remote' ? 'remote' : 'package',
        upstreamUrl,
        auth,
      };
    },
  };
};

export const createAuthServices = async (infra: Infra): Promise<AuthServices> => {
  const { config, repos, redis, logger, options } = infra;
  // The public ORIGIN (scheme included): OAuth issuer, resources and callbacks must use the scheme clients really use.
  const publicOrigin = new URL(config.publicUrl).origin;
  const keyStore = repos.keyStore;
  if (!keyStore) throw new Error('repositories were created without a secret vault');
  const scimStore = repos.scim;
  if (!scimStore) throw new Error('repositories were created without the SCIM conflict error');
  const timers: NodeJS.Timeout[] = [];
  const unsubscribers: (() => void)[] = [];
  const log = (msg: string, err: unknown) =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, msg);

  await ensureKeys(keyStore);

  // --- state keyring: one object, updated in place so every holder sees rotations ---------------------------
  const stateKeyring: Keyring = await loadStateKeyring(keyStore);
  const reloadStateKeyring = async (): Promise<void> => {
    const fresh = await loadStateKeyring(keyStore);
    Object.assign(stateKeyring, { activeKid: fresh.activeKid, keys: fresh.keys });
  };

  const fetchPolicy = {
    addressPolicy: {
      allowCidrs: config.privateUpstreamCidrs,
      clusterCidrs: config.clusterCidrs,
    },
    allowHttpToAllowedCidrs: options.allowInsecureHttp === true,
    allowHttpHosts: config.insecureUpstreamHosts,
  };
  const baseFetch = options.fetch ?? fetch;
  /** IdP, CIMD and upstream AS traffic goes through the SSRF guard (9.6, 23.3) unless a test replaces fetch. */
  const outboundFetch = options.fetch
    ? options.fetch
    : options.allowInsecureHttp
      ? createSafeFetch(baseFetch, fetchPolicy)
      : createSafeFetch(baseFetch, {
          addressPolicy: fetchPolicy.addressPolicy,
          allowHttpHosts: fetchPolicy.allowHttpHosts,
        });

  // --- identity ---------------------------------------------------------------------------------------------
  const principalStore: PrincipalStore = repos.principals;
  const revocations = createRevocationStore(infra);
  const verifier = new TokenVerifier({
    baseUrl: config.publicUrl,
    issuer: config.urls.issuer,
    keys: keyStore,
    principals: principalStore,
    revocations,
    pats: repos.pats,
  });
  unsubscribers.push(
    verifier.watchConfigEvents(infra.pubsub),
    verifier.watchRevocations(infra.pubsub),
  );
  const sessions = new SessionService({
    redis: authRedis(redis),
    principals: principalStore,
    revocations,
  });
  const pats = new PatService({
    pats: repos.pats,
    revocations,
    policy: { patMaxDays: () => repos.orgSettings.patMaxDays() },
  });
  timers.push(
    setInterval(() => {
      verifier.flushLastUsed().catch((e) => log('PAT last_used flush failed', e));
    }, LAST_USED_FLUSH_MS),
  );

  // --- authorization server -------------------------------------------------------------------------------
  const settings = await repos.orgSettings.getAll();
  const authorizationServer = await createAuthorizationServer({
    host: publicOrigin,
    orgName: settings.org.displayName,
    models: repos.oidcModels,
    signingKeys: keyStore,
    clientPolicies: repos.oauthClientPolicies,
    registration: { get: () => repos.orgSettings.clientRegistration() },
    principals: repos.principals,
    redis: authRedis(redis),
    fetch: outboundFetch,
    clientSecretKeyring: stateKeyring,
    cookieKeys: deriveCookieKeys(config.internalSecret, config.internalSecretPrevious),
    onServerError: (error) => logger.error({ err: error.message }, 'authorization server error'),
    pages: bastionProviderPages,
  });

  const refreshKeys = async (): Promise<void> => {
    await reloadStateKeyring();
    verifier.invalidateKeys();
    await authorizationServer.reload();
  };
  timers.push(
    setInterval(() => {
      refreshKeys().catch((e) => log('key refresh failed', e));
    }, KEY_REFRESH_MS),
  );
  unsubscribers.push(
    watchConfig(infra, (event) => {
      if (event.topic !== undefined && KEY_TOPICS.has(event.topic)) {
        refreshKeys().catch((e) => log('key refresh failed', e));
      }
    }),
  );

  // --- IdP login, tokens, minted credentials --------------------------------------------------------------
  const idpDeps = {
    host: publicOrigin,
    connections: repos.idpConnections,
    secrets: infra.secretStore,
    fetch: outboundFetch,
    ...(options.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
  };
  const idpClients = new IdpClients(idpDeps);
  const idpLogin = new IdpLogin({ ...idpDeps, stateKeyring });
  const idpTokens = new IdpTokenVault({ store: repos.idpTokens, secrets: infra.secretStore });

  // --- upstream OAuth broker ------------------------------------------------------------------------------
  const installationLookup = createInstallationLookup(infra);
  const broker = new UpstreamOAuthBroker({
    host: publicOrigin,
    orgName: settings.org.displayName,
    stateKeyring,
    secrets: infra.secretStore,
    clients: repos.upstreamClients,
    tokens: repos.upstreamTokens,
    signingKeys: keyStore,
    redis: authRedis(redis),
    installations: installationLookup,
    fetch: baseFetch,
    outbound: fetchPolicy,
    // openid-client refuses http on its own; the SSRF guard above still limits plain http to the insecure hosts.
    ...(options.allowInsecureHttp || config.insecureUpstreamHosts.length > 0
      ? { allowInsecureHttp: true }
      : {}),
  });
  const minted = new IdpMintedTokens({
    host: publicOrigin,
    idpClients,
    vault: idpTokens,
    broker,
    secrets: infra.secretStore,
  });
  const secretResolver: SecretResolver = {
    async resolve(ref) {
      const record = await repos.secrets.get({
        scope: ref.scope,
        ownerId: ref.ownerId,
        name: ref.name,
      });
      if (!record) return null;
      return {
        value: (await decryptSecret(infra.kms, record)).toString('utf8'),
        version: record.version,
      };
    },
  };
  const credentials = new UpstreamCredentialResolver({
    host: publicOrigin,
    secrets: secretResolver,
    broker,
    minted,
  });

  // --- deactivation (9.1) -----------------------------------------------------------------------------------
  let stopInstances: (principalId: string) => Promise<void> = async () => undefined;
  const deactivation: DeactivationExecutor = {
    async execute(action: DeactivationAction) {
      switch (action.type) {
        case 'mark_deactivated': {
          const found = await repos.users.getWithEtag(action.principalId);
          if (found && found.user.status !== 'deactivated') {
            await repos.users.update(
              action.principalId,
              { status: 'deactivated' },
              { ifMatch: found.etag, audit: { actorType: 'system' } },
            );
          }
          return;
        }
        case 'revoke_tokens':
        case 'destroy_sessions':
          // The watermark invalidates sessions and access tokens; PAT rows are revoked in the same call.
          await pats.revokeAll(action.principalId);
          return;
        case 'stop_instances':
          await stopInstances(action.principalId);
          return;
        case 'delete_upstream_tokens': {
          const rows = await repos.upstreamTokens.listByPrincipal(action.principalId);
          for (const row of rows) {
            await infra.secretStore.delete({
              scope: 'user',
              ownerId: row.principalId,
              name: `upstream-token:${row.installationId}`,
            });
            await repos.upstreamTokens.delete(row.principalId, row.installationId);
          }
          return;
        }
      }
    },
  };

  // --- SCIM -------------------------------------------------------------------------------------------------
  const enabledConnections = (await repos.idpConnections.list()).filter((c) => c.enabled);
  const scim = new ScimService({
    store: scimStore,
    tokens: repos.scimTokens,
    deactivator: {
      async deactivate(userId) {
        await executeDeactivation(planDeactivation({ principalId: userId }), deactivation);
      },
    },
    baseUrl: config.publicUrl,
    logger: { error: (message, fields) => logger.error(fields ?? {}, message) },
    connection: enabledConnections.length === 1 ? (enabledConnections[0] ?? null) : null,
  });

  return {
    stateKeyring,
    keyStore,
    principalStore,
    revocations,
    verifier,
    sessions,
    pats,
    deactivation,
    setInstanceStopper(stop) {
      stopInstances = stop;
    },
    authorizationServer,
    idpLogin,
    idpClients,
    idpTokens,
    broker,
    credentials,
    scim,
    refreshKeys,
    async close() {
      for (const t of timers) clearInterval(t);
      for (const off of unsubscribers) off();
      await verifier.flushLastUsed().catch(() => undefined);
    },
  };
};
