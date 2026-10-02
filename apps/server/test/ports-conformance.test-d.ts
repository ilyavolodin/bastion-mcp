/**
 * Compile-time proof (type-only, never executed) that `@bastion-mcp/db` repositories satisfy the real domain port
 * types, with `exactOptionalPropertyTypes: true` (docs/port-matrix.md, packages/db/test/conformance/README.md).
 * `pnpm typecheck` fails here when a repository and the port it implements drift apart; the failing `satisfies` names
 * the port and the property that differs.
 */
import type {
  SigningKeySource as IdentitySigningKeySource,
  IdpTokenStore,
  LocalAdminRepository,
  OAuthClientPolicyStore,
  OAuthIdpConnectionStore,
  OAuthSigningKeySource,
  OidcModelStore,
  PatRepository,
  PrincipalDirectory,
  PrincipalStore,
  ProvisioningRepository,
  RegistrationSettingsSource,
  ScimStore,
  ScimTokenRepository,
  ServiceAccountDirectory,
  TokenPolicy,
  UpstreamClientStore,
  UpstreamTokenStore,
} from '@bastion-mcp/auth';
import {
  createRegistryServerStore,
  createRepositories,
  createRouterRepository,
  type PrismaClient,
} from '@bastion-mcp/db';
import type {
  InstallationRegistry,
  InstallationStatusSink,
  InstanceRepository,
  SnapshotStore,
} from '@bastion-mcp/mcp-upstream';
import type { OverridesDocument } from '@bastion-mcp/overrides';
import type {
  BlobStore,
  CatalogFileStore,
  DistributionEventSink,
  ReleaseStore,
} from '@bastion-mcp/plugins';
import type {
  PolicyDataSource,
  PrincipalDirectory as PolicyPrincipalDirectory,
} from '@bastion-mcp/policy';
import type {
  InstallRequestStore,
  RegistryServerStore,
  RegistrySourceStore,
  ServerJson,
} from '@bastion-mcp/registry';
import type { EndpointDefinition, InstallationInfo } from '@bastion-mcp/router';
import type { EgressAuditSink } from '@bastion-mcp/sandbox';
import type { KeyStore, SecretRepository } from '@bastion-mcp/secrets';
import type { CallLogSink } from '@bastion-mcp/telemetry';

declare const prisma: PrismaClient;
declare const vault: never;
const must = <T>(v: T | undefined): T => v as T;
const r = createRepositories(prisma, {
  scimConflictError: (m) => new Error(m),
  secretVault: vault,
  configHash: () => 'x',
});

export const checks = async () => ({
  secretRepo: r.secrets satisfies SecretRepository,
  keyStore: must(r.keyStore) satisfies KeyStore,
  principalStore: r.principals satisfies PrincipalStore,
  pat: r.pats satisfies PatRepository,
  idSigning: must(r.keyStore) satisfies IdentitySigningKeySource,
  oauthSigning: must(r.keyStore) satisfies OAuthSigningKeySource,
  provisioning: r.provisioning satisfies ProvisioningRepository,
  scim: must(r.scim) satisfies ScimStore,
  scimTokens: r.scimTokens satisfies ScimTokenRepository,
  sa: r.serviceAccounts satisfies ServiceAccountDirectory,
  local: r.localAdmins satisfies LocalAdminRepository,
  oidc: r.oidcModels satisfies OidcModelStore,
  clientPolicy: r.oauthClientPolicies satisfies OAuthClientPolicyStore,
  idp: r.idpConnections satisfies OAuthIdpConnectionStore,
  idpTokens: r.idpTokens satisfies IdpTokenStore,
  upClients: r.upstreamClients satisfies UpstreamClientStore,
  upTokens: r.upstreamTokens satisfies UpstreamTokenStore,
  principalDir: r.principals satisfies PrincipalDirectory,
  policyPrincipalDir: r.principals satisfies PolicyPrincipalDirectory,
  regSettings: {
    get: async () => r.orgSettings.clientRegistration(),
  } satisfies RegistrationSettingsSource,
  tokenPolicy: r.orgSettings satisfies TokenPolicy,
  regSources: r.registrySources satisfies RegistrySourceStore,
  regServers: createRegistryServerStore<ServerJson>(prisma, {
    parseServerJson: (raw) => raw as ServerJson,
  }) satisfies RegistryServerStore,
  routerInfo: (await createRouterRepository<OverridesDocument>(prisma).listForPrincipal({
    id: 'x',
    type: 'user',
    teamIds: [],
  })) satisfies InstallationInfo[],
  endpointDef: (await r.endpoints.findDefinition('x')) satisfies EndpointDefinition | null,
  installRequests: r.installRequests satisfies InstallRequestStore,
  blobs: r.blobs satisfies BlobStore,
  files: r.catalogFiles satisfies CatalogFileStore,
  releases: r.releases satisfies ReleaseStore,
  dist: r.distributionEvents satisfies DistributionEventSink,
  policyData: r.policyData satisfies PolicyDataSource,
  instances: r.instances satisfies InstanceRepository,
  snapshots: r.snapshots satisfies SnapshotStore,
  status: r.installations satisfies InstallationStatusSink,
  registry: must(r.installationRegistry) satisfies InstallationRegistry,
  callLogSink: r.callLog.insertBatch satisfies CallLogSink,
  egress: r.egressEvents satisfies EgressAuditSink,
});
void checks;
