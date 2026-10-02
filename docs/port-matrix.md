# Port matrix: domain ports and their `@bastion-mcp/db` implementations

`@bastion-mcp/db` may import only `@bastion-mcp/core` (5.3), so each repository implements its port
**structurally**: the shapes are copied from the port definitions and `apps/server` assigns the repository to the
port type, which is the compile-time conformance check. The same assignments were verified against the real port
types with `exactOptionalPropertyTypes: true` (the setting `apps/server` uses) when this layer was written; the
checker is kept as `packages/db/test/conformance/ports.conformance.ts.txt` (see the README next to it).

Factories live in `packages/db/src/repositories/<area>.ts`, take a `PrismaClient`, a transaction client or a
`RepoContext`, and are all created by `createRepositories(db, deps)`. `withTransaction(prisma, fn, options)` binds
them to one transaction (audit events and `config_versions` bumps in the same transaction, `bastion:config` publish
after commit). Tests are `packages/db/test/repositories/*.integration.test.ts` against Postgres 17 (Testcontainers).

## Ports implemented

| Port interface | Package (file) | db implementation | Test |
| --- | --- | --- | --- |
| `SecretRepository` | `secrets` (`types.ts`) | `createSecretRepository` (`secrets.ts`), plus `getById`, `deleteById` | `auth-stores` |
| `KeyStore` | `secrets` (`keyring.ts`) | `createKeyStore(db, vault)` (`secrets.ts`); `vault` is a `SecretVault` | `auth-stores` |
| `SigningKeySource` (identity and oauth) | `auth` (`identity/ports.ts`, `oauth/ports.ts`) | the same `createKeyStore` object (`listSigningKeys`, `loadSigningPrivateKey`) | `auth-stores` |
| `PrincipalStore` | `auth` (`identity/ports.ts`) | `createPrincipalRepository().getPrincipal` (`provisioning.ts`) | `identity` |
| `PatRepository` | `auth` (`identity/ports.ts`) | `createPatRepository` (`tokens.ts`) | `auth-stores` |
| `TokenPolicy` | `auth` (`identity/ports.ts`) | `createOrgSettingsRepository().patMaxDays` (`org.ts`) | `catalog` |
| `ProvisioningRepository` | `auth` (`identity/provisioning/plan.ts`) | `createProvisioningRepository().applyPlan` (`provisioning.ts`) | `identity` |
| `ScimStore` | `auth` (`identity/scim/types.ts`) | `createScimStore(db, { conflictError })` (`provisioning.ts`) | `identity` |
| `ScimTokenRepository` | `auth` (`identity/scim/types.ts`) | `createScimTokenRepository` (`tokens.ts`) | `auth-stores` |
| `ServiceAccountDirectory` | `auth` (`identity/service-accounts`) | `createServiceAccountRepository` (`tokens.ts`) | `auth-stores` |
| `LocalAdminRepository` | `auth` (`identity/break-glass.ts`) | `createLocalAdminRepository` (`users.ts`) | `identity` |
| `OidcModelStore` | `auth` (`oauth/ports.ts`) | `createOidcModelStore` (`oauth.ts`) | `auth-stores` |
| `OAuthClientPolicyStore` | `auth` (`oauth/ports.ts`) | `createOAuthClientPolicyRepository` (`tokens.ts`) | `auth-stores` |
| `IdpConnectionStore` | `auth` (`oauth/ports.ts`) | `createIdpConnectionRepository` (`oauth.ts`; also CRUD with ETag) | `auth-stores` |
| `IdpTokenStore` | `auth` (`oauth/ports.ts`) | `createIdpTokenStore` (`oauth.ts`) | `auth-stores` |
| `UpstreamClientStore` | `auth` (`oauth/ports.ts`) | `createUpstreamClientStore` (`oauth.ts`) | `auth-stores` |
| `UpstreamTokenStore` | `auth` (`oauth/ports.ts`) | `createUpstreamTokenStore` (`oauth.ts`) | `auth-stores` |
| `PrincipalDirectory` (oauth) | `auth` (`oauth/ports.ts`) | `createPrincipalRepository` (`isUserActive`, `serviceAccountForClient`) | `identity` |
| `RegistrationSettingsSource` | `auth` (`oauth/ports.ts`) | `{ get: () => orgSettings.clientRegistration() }` (`org.ts`) | `catalog` |
| `SecretStore` | `auth` (`oauth/ports.ts`) | **composition in `apps/server`**: `put`/`reveal`/`delete` through `SecretVault`; `revealById` = `secrets.getById(id)` + `decryptSecret(kms, record)` | `auth-stores` (repository half) |
| `RegistrySourceStore` | `registry` (`ports.ts`) | `createRegistrySourceStore` (`registry.ts`) | `distribution` |
| `RegistryServerStore` | `registry` (`ports.ts`) | `createRegistryServerStore<ServerJson>(db, { parseServerJson })` (`registry.ts`), full-text `search` | `distribution` |
| `InstallRequestStore` | `registry` (`ports.ts`) | `createInstallRequestStore` (`registry.ts`) | `distribution` |
| `BlobStore` | `plugins` (`ports.ts`) | `createBlobStore` (`catalog.ts`) | `catalog` |
| `CatalogFileStore` | `plugins` (`ports.ts`) | `createCatalogFileStore` (`catalog.ts`) | `catalog` |
| `MarketplaceStore` | `plugins` (`ports.ts`) | `createMarketplaceStore(db, { assemble })` (`plugins.ts`); `assemble` wraps `importPluginTree` | `distribution` |
| `ReleaseStore` | `plugins` (`ports.ts`) | `createReleaseStore` (`plugins.ts`) | `distribution` |
| `DistributionEventSink` | `plugins` (`ports.ts`) | `createDistributionEventSink` (`plugins.ts`) | `distribution` |
| `PolicyDataSource` | `policy` (`ports.ts`) | `createPolicyDataSource().load` (`security.ts`) | `security` |
| `PrincipalDirectory` (policy) | `policy` (`ports.ts`) | `createPrincipalRepository().find` | `identity` |
| `InstallationInfo` mapping | `router` (`types.ts`) | `createRouterRepository<OverridesDocument>({ parseOverrides }).listForPrincipal` (`installations.ts`) | `installations` |
| `EndpointDefinition` mapping | `router` (`types.ts`) | `createEndpointRepository().findDefinition` (`installations.ts`) | `installations` |
| `InstanceRepository` | `mcp-upstream` (`ports.ts`) | `createInstanceRepository` (`instances.ts`), plus `claimIdle` (`FOR UPDATE SKIP LOCKED`) | `runtime` |
| `SnapshotStore` | `mcp-upstream` (`ports.ts`) | `createSnapshotStore` (`instances.ts`), plus `putReference` | `runtime` |
| `InstallationStatusSink` | `mcp-upstream` (`ports.ts`) | `createInstallationRepository` (`markError`, `clearError`) | `installations` |
| `InstallationRegistry` | `mcp-upstream` (`ports.ts`) | `createInstallationRegistry(db, { configHash })` (`installations.ts`); `configHash` = router `computeConfigHash` | `installations` |
| `CallLogSink` | `telemetry` (`call-log.ts`) | `createCallLogRepository().insertBatch` (`telemetry.ts`) | `telemetry` |
| `EgressAuditSink` | `sandbox` (`egress/audit.ts`) | `createEgressEventRepository().record` (`telemetry.ts`) | `telemetry` |

## Repositories without a port (shape defined here)

| Area | Factory (file) | Notes |
| --- | --- | --- |
| Users, teams, memberships | `createUserRepository`, `createTeamRepository` (`users.ts`, `teams.ts`) | filters, keyset cursors, ETag, audit |
| Role mapping rules | `createRoleMappingRuleRepository` (`teams.ts`) | `maps_to` validated |
| Org settings | `createOrgSettingsRepository` (`org.ts`) | `orgSettingsSchema` from core on write and read |
| Notifications, config versions | `createNotificationRepository`, `createConfigVersionRepository` (`org.ts`) | |
| Catalog entries and versions | `createCatalogEntryRepository`, `createCatalogVersionRepository` (`catalog.ts`) | `serverSpecSchema` from core; weighted `tsvector` maintained on write |
| Executable approvals | `createExecutableApprovalRepository` (`catalog.ts`) | |
| Installations, prefs, endpoints | `createInstallationRepository`, `createEndpointRepository` (`installations.ts`) | |
| Auto-install | `createAutoInstallRepository` (`installations.ts`) | `applyOnce` is idempotent on `(policy_id, subject_type, subject_id)` |
| Policy rules, custom policies | `createPolicyRuleRepository`, `createCustomPolicyRepository` (`security.ts`) | |
| Limit rules | `createLimitRuleRepository` (`security.ts`) | params validated per kind |
| Guard profiles | `createGuardProfileRepository` (`security.ts`) | single org default; `toPipelineProfile` |
| Definition pins, drift reviews | `createDefinitionPinRepository`, `createDriftReviewRepository` (`security.ts`) | approval re-pins in the same transaction |
| Registry policy | `createRegistryPolicyStore` (`registry.ts`) | |
| Marketplaces, plugin sources | `createMarketplaceRepository`, `createPluginSourceRepository` (`plugins.ts`) | |
| Egress access requests | `createEgressAccessRequestRepository` (`instances.ts`) | |
| Call log reads, rollups, retention | `createCallLogRepository` (`telemetry.ts`) | `list`, `get`, `rollupMinuteJob`/`rollupHourJob`/`rollupDayJob`, `stats`, `applyRetention` |
| Audit reads | `createAuditLogRepository` (`audit-log.ts`) | `list`, streaming `export`, `verify`, `pruneBefore` |

## Mismatches between ports and the schema (all resolved in migration `0002_repositories`)

1. `users.scim_external_id` was missing (`ScimUserRecord.externalId`, `UserChange.scimExternalId`); added with a unique
   index per IdP connection.
2. `service_accounts` had no `auth_method`, `secret_sha256`, `jwks` (`ServiceAccountClient`); added (the client lives in
   the account row), plus `updated_at` and `status`/`auth_method` CHECKs.
3. `secrets (scope, owner_id, name)` cannot be unique for org and system secrets (NULL owner): added a partial unique
   index on `(scope, name) WHERE owner_id IS NULL`.
4. No `updated_at` (the ETag source) on `role_mapping_rules`, `auto_install_policies`, `registry_sources`,
   `service_accounts`; added.
5. `registry_sources.auth_header_name` (`RegistrySource.authHeaderName`) and `registry_servers.meta`
   (`RegistryServerRow.meta`) were missing; `searchDocument` is only fed to `to_tsvector` and is not stored.
6. `call_stats_minute/hour/day.error_count` was missing (`MinuteStats.errorCount`, 15.5 "error count"); added.
7. `egress_events.protocol` and `reason` were missing (`EgressAuditEvent`); added.
8. `instances` lacked `user_id`, `remote_session`, `running_version_id`, `failures` (`InstanceRecord`); added.
   `failure_count` mirrors `failures.length`; `state` is derived (`starting`, `running`, `failed`, `stopping`).
9. `upstream_snapshots.ttl_ms` was missing (`SnapshotItems.ttlMs`); added.
10. `guard_profiles` has three columns but `guardProfileSchema` has more (`maxScanBytes`, `onOversize`, `onDrift`,
    `riskEscalation`); added `settings jsonb`.
11. `ResolvedInstallation` needs catalog flags with no column (`enableSampling`, `enableRoots`, `roots`, `extensions`,
    `replicas`, `listTtlMs`); added `catalog_versions.runtime jsonb`.
12. `ReleaseRecord.items` is `{name, version, policy}` but `marketplace_releases.items` is
    `[{entryId, versionId, policy}]`: the stored JSON carries `name` and `version` as well. `releaseTime` is
    `created_at`.
13. `MarketplaceRow.ownerName` has no column: it is the owner team's display name, else the injected default.
14. `InstallationInfo.catalogEntryId` and policy `installations[].catalogEntryId` are required, but personal
    installations have no entry: the installation id is used. `InstallationInfo.capabilities` has no column: it is
    derived from the newest snapshot (non-empty lists), "everything" until one exists.
15. `ScimStoreConflictError` is a class of `auth`; the store takes `conflictError: (message) => Error` from the server.
16. `RunnerTokenStore` (`mcp-upstream`) has no column and is **not implemented** here; store the encrypted token as a
    `system` secret `runner:<instanceId>` through `SecretVault` in `apps/server`.
17. State keys (`StateKeyMaterial`) have no table: they are `system` secrets `state:<kid>` whose encrypted value also
    carries `activeFrom` and `retireAfter`.
18. Missing CHECKs added: `personal_access_tokens.principal_type`, `upstream_tokens.principal_type`,
    `endpoints.prefix_mode`, `upstream_clients.registration`, `auto_install_applications.subject_type`,
    `egress_events.decision`, `call_log.outcome` and `principal_type`, `registry_sources.trust`,
    `registry_servers.status`, and a partial unique index allowing one `guard_profiles.is_org_default`.
    `schema-conformance.test.ts` covers them.
19. Policy tool rules carry no owner team in `ToolRuleRow`; `policy_rules.owner_team_id` is stored but not exported.
19b. (migration `0003_server_runtime`) `call_log.origin` (`direct` | `plugin`, CHECK constrained) tags rows of `/mcp/c/{catalogSlug}` calls (7.1, 25.8). `CallLogRow` of `db` accepts an optional `origin`; the telemetry package's row schema does not carry it, so `apps/server` sets it when the call arrived through a catalog route. List and detail views return it.

## Conventions the API layer relies on

- ETag is `"<updated_at ms in base36>"` (or `created_at` before the first update); `assertIfMatch` throws 428 without
  `If-Match` and 412 on mismatch; updates are compare-and-swap on `updated_at`, so concurrent PATCHes yield one winner.
- Pagination returns `{ items, nextCursor }` with opaque cursors; most lists are keyset on `id desc` (UUIDv7).
- Every mutating method accepts an `AuditContext` and writes its audit event in the same transaction; a failed call
  writes nothing. Config bumps (`org`, `user`, `team`, `installation`, `catalog`, `endpoint`) are applied in a fixed
  order inside the transaction and published through `RepoOptions.publishConfig` after the commit.
