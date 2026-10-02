import { Prisma, type PrismaClient } from '../generated/client';
import { createAuditLogRepository } from './audit-log';
import {
  createBlobStore,
  createCatalogEntryRepository,
  createCatalogFileStore,
  createCatalogVersionRepository,
  createExecutableApprovalRepository,
} from './catalog';
import {
  createAutoInstallRepository,
  createEndpointRepository,
  createInstallationRegistry,
  createInstallationRepository,
  createRouterRepository,
} from './installations';
import {
  createEgressAccessRequestRepository,
  createInstanceRepository,
  createSnapshotStore,
} from './instances';
import {
  createIdpConnectionRepository,
  createIdpTokenStore,
  createOidcModelStore,
  createUpstreamClientStore,
  createUpstreamTokenStore,
} from './oauth';
import { createConfigVersionRepository, createNotificationRepository, createOrgSettingsRepository } from './org';
import {
  createDistributionEventSink,
  createMarketplaceRepository,
  createMarketplaceStore,
  createPluginSourceRepository,
  createReleaseStore,
  type ItemPolicy,
  type MarketplaceStoreDeps,
} from './plugins';
import {
  createPrincipalRepository,
  createProvisioningRepository,
  createScimStore,
} from './provisioning';
import {
  createInstallRequestStore,
  createRegistryPolicyStore,
  createRegistryServerStore,
  createRegistrySourceStore,
} from './registry';
import { createKeyStore, createSecretRepository, type SecretCodec } from './secrets';
import {
  createCustomPolicyRepository,
  createDefinitionPinRepository,
  createDriftReviewRepository,
  createGuardProfileRepository,
  createLimitRuleRepository,
  createPolicyDataSource,
  createPolicyRuleRepository,
} from './security';
import {
  flushUnit,
  type PrismaLike,
  publishAfterCommit,
  type RepoContext,
  type RepoOptions,
  TX_OPTIONS,
  type Tx,
  toContext,
  UnitState,
} from './support';
import { createRoleMappingRuleRepository, createTeamRepository } from './teams';
import { createCallLogRepository, createEgressEventRepository } from './telemetry';
import {
  createOAuthClientPolicyRepository,
  createPatRepository,
  createScimTokenRepository,
  createServiceAccountRepository,
} from './tokens';
import { createLocalAdminRepository, createUserRepository } from './users';

/** Collaborators that only the server shell can supply (see `docs/port-matrix.md`). */
export type RepositoryDeps = {
  /** Builds `ScimStoreConflictError` of `@bastion-mcp/auth`; enables `repos.scim`. */
  scimConflictError?: (message: string) => Error;
  /** A `SecretVault` of `@bastion-mcp/secrets`; enables `repos.keyStore`. */
  secretVault?: SecretCodec;
  /** `importPluginTree` glue of `@bastion-mcp/plugins`; enables `repos.marketplaceStore`. */
  marketplaceAssemble?: MarketplaceStoreDeps<{ name: string; version: string; policy: ItemPolicy }>['assemble'];
  /** `computeConfigHash` of `@bastion-mcp/router`; enables `repos.installationRegistry`. */
  configHash?: Parameters<typeof createInstallationRegistry>[1]['configHash'];
};

/** Every repository bound to one database handle (a client, or a transaction through `withTransaction`). */
export const createRepositories = (
  arg: PrismaLike | RepoContext,
  deps: RepositoryDeps = {},
  options: RepoOptions = {},
) => {
  const ctx = toContext(arg, options);
  return {
    users: createUserRepository(ctx),
    localAdmins: createLocalAdminRepository(ctx),
    teams: createTeamRepository(ctx),
    roleMappingRules: createRoleMappingRuleRepository(ctx),
    principals: createPrincipalRepository(ctx),
    provisioning: createProvisioningRepository(ctx),
    pats: createPatRepository(ctx),
    scimTokens: createScimTokenRepository(ctx),
    serviceAccounts: createServiceAccountRepository(ctx),
    oauthClientPolicies: createOAuthClientPolicyRepository(ctx),
    oidcModels: createOidcModelStore(ctx),
    idpConnections: createIdpConnectionRepository(ctx),
    idpTokens: createIdpTokenStore(ctx),
    upstreamClients: createUpstreamClientStore(ctx),
    upstreamTokens: createUpstreamTokenStore(ctx),
    secrets: createSecretRepository(ctx),
    orgSettings: createOrgSettingsRepository(ctx),
    notifications: createNotificationRepository(ctx),
    configVersions: createConfigVersionRepository(ctx),
    catalogEntries: createCatalogEntryRepository(ctx),
    catalogVersions: createCatalogVersionRepository(ctx),
    blobs: createBlobStore(ctx),
    catalogFiles: createCatalogFileStore(ctx),
    executableApprovals: createExecutableApprovalRepository(ctx),
    installations: createInstallationRepository(ctx),
    endpoints: createEndpointRepository(ctx),
    autoInstall: createAutoInstallRepository(ctx),
    router: createRouterRepository(ctx),
    policyRules: createPolicyRuleRepository(ctx),
    customPolicies: createCustomPolicyRepository(ctx),
    policyData: createPolicyDataSource(ctx),
    limitRules: createLimitRuleRepository(ctx),
    guardProfiles: createGuardProfileRepository(ctx),
    definitionPins: createDefinitionPinRepository(ctx),
    driftReviews: createDriftReviewRepository(ctx),
    registrySources: createRegistrySourceStore(ctx),
    registryServers: createRegistryServerStore(ctx),
    registryPolicies: createRegistryPolicyStore(ctx),
    installRequests: createInstallRequestStore(ctx),
    marketplaces: createMarketplaceRepository(ctx),
    releases: createReleaseStore(ctx),
    distributionEvents: createDistributionEventSink(ctx),
    pluginSources: createPluginSourceRepository(ctx),
    callLog: createCallLogRepository(ctx),
    egressEvents: createEgressEventRepository(ctx),
    egressAccessRequests: createEgressAccessRequestRepository(ctx),
    auditLog: createAuditLogRepository(ctx),
    instances: createInstanceRepository(ctx),
    snapshots: createSnapshotStore(ctx),
    ...(deps.scimConflictError
      ? { scim: createScimStore(ctx, { conflictError: deps.scimConflictError }) }
      : {}),
    ...(deps.secretVault ? { keyStore: createKeyStore(ctx, deps.secretVault) } : {}),
    ...(deps.marketplaceAssemble
      ? { marketplaceStore: createMarketplaceStore(ctx, { assemble: deps.marketplaceAssemble }) }
      : {}),
    ...(deps.configHash
      ? { installationRegistry: createInstallationRegistry(ctx, { configHash: deps.configHash }) }
      : {}),
  };
};

export type Repositories = ReturnType<typeof createRepositories>;

/** What a `withTransaction` callback receives. */
export type UnitOfWork = {
  /** The raw transaction client, for the odd query no repository covers. */
  tx: Tx;
  /** Every repository bound to the transaction. */
  repos: Repositories;
  /** Registers work to run after the commit, once the `bastion:config` events were published. */
  afterCommit: (hook: () => void | Promise<void>) => void;
};

export type TransactionOptions = RepoOptions & {
  /** Retries when Postgres aborts the transaction on a deadlock or write conflict (`P2034`). Default 2. */
  retries?: number;
  deps?: RepositoryDeps;
};

const isConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';

/**
 * Runs `fn` in one transaction (17.1: "every mutating route writes an audit event in the same transaction").
 * Repository mutations join it; at the end the recorded config bumps are applied in a fixed order, the audit events
 * are appended, the transaction commits and only then `publishConfig` runs for each `{scope, id, version}` (4.3),
 * followed by the `afterCommit` hooks. A thrown error rolls everything back and publishes nothing.
 */
export const withTransaction = async <T>(
  prisma: PrismaClient,
  fn: (uow: UnitOfWork) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> => {
  const attempts = (options.retries ?? 2) + 1;
  for (let attempt = 1; ; attempt++) {
    const unit = new UnitState();
    try {
      const done = await prisma.$transaction(async (tx) => {
        const repos = createRepositories({ ...options, db: tx, unit }, options.deps ?? {});
        const out = await fn({
          tx,
          repos,
          afterCommit: (hook) => void unit.afterCommit.push(hook),
        });
        return { out, events: await flushUnit(tx, unit) };
      }, TX_OPTIONS);
      await publishAfterCommit(options, done.events, unit);
      return done.out;
    } catch (error) {
      if (attempt >= attempts || !isConflict(error)) throw error;
    }
  }
};
