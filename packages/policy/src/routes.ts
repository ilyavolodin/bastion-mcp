import type { ManagementAction } from './schema';

export type RouteRole = 'admin' | 'manager' | 'member' | 'auditor';

/**
 * `allow`: every instance of the resource kind. `scoped`: only instances in the caller's scope (own
 * resources, teams they manage, entries visible to them). `deny`: none.
 */
export type Grant = 'allow' | 'scoped' | 'deny';

export type RouteResourceKind = 'Org' | 'Team' | 'CatalogEntry' | 'Installation' | 'User';

export type RouteAction = {
  id: string;
  area: string;
  /** Routes under `/api/v1` (17.2) that authorize with this action on this resource kind. */
  routes: readonly string[];
  /** Null only for authenticated self-service routes that touch nothing but the caller's own data. */
  action: ManagementAction | null;
  /** The resource the handler passes to `authorize`; null with a null action. */
  resource: RouteResourceKind | null;
  grants: Readonly<Record<RouteRole, Grant>>;
  /**
   * What a service account (a principal of one team that holds the `member` capabilities for its OWN
   * installations only, 10.1) is granted. Omitted means the `member` grant. User-only capabilities (personal
   * installs, registry install, user secrets, user call logs) are `deny`.
   */
  serviceAccount?: Grant;
  note?: string;
};

const g = (
  admin: Grant,
  manager: Grant,
  member: Grant,
  auditor: Grant,
): Record<RouteRole, Grant> => ({ admin, manager, member, auditor });

/**
 * Every management route area of 17.2 mapped to its Cedar action and the roles allowed (10.1). Where a
 * handler picks the resource from the request (for example the team being published to), there is one row
 * per resource kind. The api package drives its table-driven authorization test (23.3) from this table, and
 * the policy package's own tests prove the engine agrees with every row.
 *
 * "manager" is a member who manages the team in scope; "scoped" always means that team or the caller's own.
 */
/** The grant a service account holds on a row (10.1). */
export const serviceAccountGrant = (row: Pick<RouteAction, 'grants' | 'serviceAccount'>): Grant =>
  row.serviceAccount ?? row.grants.member;

export const ROUTE_ACTIONS: readonly RouteAction[] = [
  // --- Session and self -------------------------------------------------------------------------------
  {
    id: 'self',
    area: 'Session and self',
    routes: [
      'GET /me',
      'PATCH /me',
      'POST /me/password',
      'GET /me/notifications',
      'POST /me/notifications/{id}/read',
      'GET /me/quotas',
      'GET /me/oauth-grants',
      'DELETE /me/oauth-grants/{id}',
      'GET /tokens',
      'POST /tokens',
      'DELETE /tokens/{id}',
    ],
    action: null,
    resource: null,
    grants: g('allow', 'allow', 'allow', 'allow'),
    note: 'Authenticated principal acting on its own data; no Cedar decision is needed.',
  },
  // --- Read-only views of org configuration (10.1: "View") -----------------------------------------------
  {
    id: 'org.view',
    area: 'Org configuration (read)',
    routes: [
      'GET /users',
      'GET /users/{id}',
      'GET /teams',
      'GET /role-mapping-rules',
      'GET /service-accounts',
      'GET /idp-connections',
      'GET /idp-connections/{id}',
      'GET /scim-tokens',
      'GET /oauth-clients',
      'GET /plugin-sources',
      'GET /auto-install-policies',
      'GET /registry-sources',
      'GET /registry-sources/{id}/policy',
      'GET /policy-rules',
      'GET /custom-policies',
      'GET /drift-reviews',
      'GET /guard-profiles',
      'GET /guard-profiles/{id}',
      'GET /settings/model-guards',
      'GET /limit-rules',
      'GET /limit-rules/{id}/usage',
      'GET /settings',
      'GET /system/status',
    ],
    action: 'seeCatalog',
    resource: 'Org',
    grants: g('allow', 'allow', 'deny', 'allow'),
  },
  {
    id: 'team.view',
    area: 'Users and teams',
    routes: ['GET /teams/{id}'],
    action: 'seeCatalog',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'allow'),
  },
  // --- Users and teams ---------------------------------------------------------------------------------
  {
    id: 'users.write',
    area: 'Users and teams',
    routes: [
      'POST /users',
      'PATCH /users/{id}',
      'POST /users/{id}/deactivate',
      'POST /role-mapping-rules',
      'PATCH /role-mapping-rules/{id}',
      'DELETE /role-mapping-rules/{id}',
    ],
    action: 'user.manage',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'teams.write',
    area: 'Users and teams',
    routes: ['POST /teams', 'PATCH /teams/{id}', 'DELETE /teams/{id}'],
    action: 'team.manage',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'teams.members',
    area: 'Users and teams',
    routes: ['PUT /teams/{id}/members/{userId}', 'DELETE /teams/{id}/members/{userId}'],
    action: 'user.manage',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
  },
  {
    id: 'service-accounts.write',
    area: 'Service accounts and tokens',
    routes: [
      'POST /service-accounts',
      'PATCH /service-accounts/{id}',
      'DELETE /service-accounts/{id}',
      'POST /service-accounts/{id}/credentials',
    ],
    action: 'user.manage',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    note: "The resource is the service account's team; that team's managers administer it (10.1).",
  },
  // --- Identity providers and OAuth clients --------------------------------------------------------------
  {
    id: 'idp.write',
    area: 'Identity providers',
    routes: [
      'POST /idp-connections',
      'PATCH /idp-connections/{id}',
      'DELETE /idp-connections/{id}',
      'POST /idp-connections/{id}/test',
      'POST /scim-tokens',
      'DELETE /scim-tokens/{id}',
    ],
    action: 'settings.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'oauth-clients.write',
    area: 'OAuth clients',
    routes: ['POST /oauth-clients', 'PATCH /oauth-clients/{id}'],
    action: 'settings.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  // --- Catalog and store -------------------------------------------------------------------------------
  {
    id: 'catalog.read',
    area: 'Catalog',
    routes: [
      'GET /catalog',
      'GET /catalog/{id}',
      'GET /catalog/{id}/versions',
      'GET /catalog/{id}/versions/{vid}',
      'GET /catalog/{id}/versions/{vid}/test',
      'GET /catalog/{id}/versions/{vid}/files',
      'GET /catalog/{id}/versions/{vid}/files/{path}',
      'GET /store',
      'GET /store/{slug}',
      'GET /marketplaces',
      'GET /marketplaces/{id}',
      'GET /marketplaces/{id}/releases',
      'GET /marketplaces/{id}/mirror',
      'GET /marketplaces/{id}/rollout',
      'GET /marketplaces/{id}/usage',
    ],
    action: 'seeCatalog',
    resource: 'CatalogEntry',
    grants: g('allow', 'scoped', 'scoped', 'allow'),
    note: 'Members see what visibility allows; marketplace routes also check the marketplace audience (404).',
  },
  {
    id: 'catalog.create.team',
    area: 'Catalog',
    routes: ['POST /catalog', 'POST /catalog/import'],
    action: 'catalog.create',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    note: 'Entry scoped to a team: the resource is that team.',
  },
  {
    id: 'catalog.create.org',
    area: 'Catalog',
    routes: ['POST /catalog', 'POST /catalog/import'],
    action: 'catalog.create',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
    note: 'Org-owned entry.',
  },
  {
    id: 'catalog.update',
    area: 'Catalog',
    routes: [
      'PATCH /catalog/{id}',
      'POST /catalog/{id}/versions',
      'PATCH /catalog/{id}/versions/{vid}',
      'POST /catalog/{id}/versions/{vid}/test',
      'PUT /catalog/{id}/versions/{vid}/files/{path}',
      'DELETE /catalog/{id}/versions/{vid}/files/{path}',
    ],
    action: 'catalog.update',
    resource: 'CatalogEntry',
    grants: g('allow', 'scoped', 'deny', 'deny'),
  },
  {
    id: 'catalog.delete',
    area: 'Catalog',
    routes: ['DELETE /catalog/{id}'],
    action: 'catalog.delete',
    resource: 'CatalogEntry',
    grants: g('allow', 'scoped', 'deny', 'deny'),
  },
  {
    id: 'catalog.publish.team',
    area: 'Catalog',
    routes: ['POST /catalog/{id}/versions/{vid}/publish'],
    action: 'catalog.publish',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    note: 'Publishing to team T: the resource is T.',
  },
  {
    id: 'catalog.publish.org',
    area: 'Catalog',
    routes: ['POST /catalog/{id}/versions/{vid}/publish'],
    action: 'catalog.publish',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
    note: 'Org-wide: managers only with `catalog.publishOrgWide` (orgWidePublisherIds).',
  },
  {
    id: 'plugin.approve-executable',
    area: 'Skills and plugins',
    routes: ['POST /catalog/{id}/versions/{vid}/approve-executable'],
    action: 'plugin.approveExecutable',
    resource: 'CatalogEntry',
    grants: g('allow', 'deny', 'deny', 'deny'),
    note: 'Admin only (10.1, 25.2).',
  },
  {
    id: 'plugin-sources.write',
    area: 'Skills and plugins',
    routes: [
      'POST /plugin-sources',
      'PATCH /plugin-sources/{id}',
      'DELETE /plugin-sources/{id}',
      'POST /plugin-sources/{id}/sync',
    ],
    action: 'marketplace.manage',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  // --- Marketplaces ------------------------------------------------------------------------------------
  {
    id: 'marketplaces.write.team',
    area: 'Marketplaces',
    routes: [
      'POST /marketplaces',
      'PATCH /marketplaces/{id}',
      'DELETE /marketplaces/{id}',
      'PUT /marketplaces/{id}/items/{entryId}',
      'DELETE /marketplaces/{id}/items/{entryId}',
      'POST /marketplaces/{id}/releases/{n}/promote',
      'PUT /marketplaces/{id}/mirror',
      'POST /marketplaces/{id}/mirror/push',
    ],
    action: 'marketplace.manage',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    note: 'Team-owned marketplace: the resource is the owning team.',
  },
  {
    id: 'marketplaces.write.org',
    area: 'Marketplaces',
    routes: [
      'POST /marketplaces',
      'PATCH /marketplaces/{id}',
      'DELETE /marketplaces/{id}',
      'PUT /marketplaces/{id}/items/{entryId}',
      'DELETE /marketplaces/{id}/items/{entryId}',
      'POST /marketplaces/{id}/releases/{n}/promote',
      'PUT /marketplaces/{id}/mirror',
      'POST /marketplaces/{id}/mirror/push',
    ],
    action: 'marketplace.manage',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
    note: 'Org-owned marketplace.',
  },
  // --- Installations, endpoints, overrides ------------------------------------------------------------------
  {
    id: 'installations.personal',
    area: 'Installations',
    routes: [
      'GET /installations',
      'POST /installations',
      'GET/POST /endpoints',
      'GET/PATCH/DELETE /endpoints/{id}',
      'GET /endpoints/{id}/client-config',
      'GET /client-config',
      'POST /overrides/preview',
    ],
    action: 'installation.manage',
    resource: 'Org',
    grants: g('allow', 'allow', 'allow', 'allow'),
    serviceAccount: 'deny',
    note: "Personal (non-catalog) installs and the caller's own endpoints; `personalInstalls` is an org setting.",
  },
  {
    id: 'installations.from-entry',
    area: 'Installations',
    routes: ['POST /installations'],
    action: 'installation.manage',
    resource: 'CatalogEntry',
    grants: g('allow', 'scoped', 'scoped', 'scoped'),
    note: 'Installing a catalog entry needs that entry to be visible to the caller.',
  },
  {
    id: 'installations.team',
    area: 'Installations',
    routes: ['POST /installations'],
    action: 'installation.manage',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    note: 'Team installations and shared credentials (10.1).',
  },
  {
    id: 'installations.manage',
    area: 'Installations',
    routes: [
      'GET /installations/{id}',
      'PATCH /installations/{id}',
      'DELETE /installations/{id}',
      'POST /installations/{id}/restart',
      'GET /installations/{id}/tools',
      'GET /installations/{id}/prompts',
      'GET /installations/{id}/resources',
      'GET /installations/{id}/templates',
      'POST /installations/{id}/try',
      'GET /installations/{id}/logs',
      'GET /installations/{id}/egress',
      'POST /installations/{id}/connect',
      'DELETE /installations/{id}/connection',
      'PUT /installations/{id}/secrets/{name}',
    ],
    action: 'installation.manage',
    resource: 'Installation',
    grants: g('allow', 'scoped', 'scoped', 'scoped'),
  },
  {
    id: 'overrides.installation',
    area: 'Overrides',
    routes: ['GET /installations/{id}/overrides', 'PUT /installations/{id}/overrides'],
    action: 'override.edit',
    resource: 'Installation',
    grants: g('allow', 'scoped', 'scoped', 'scoped'),
  },
  {
    id: 'overrides.catalog',
    area: 'Overrides',
    routes: [
      'GET /catalog/{id}/versions/{vid}/overrides',
      'PUT /catalog/{id}/versions/{vid}/overrides',
    ],
    action: 'override.edit',
    resource: 'CatalogEntry',
    grants: g('allow', 'scoped', 'deny', 'deny'),
  },
  {
    id: 'drift.write',
    area: 'Drift',
    routes: ['POST /drift-reviews/{id}/approve', 'POST /drift-reviews/{id}/reject'],
    action: 'guard.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  // --- Auto-install ------------------------------------------------------------------------------------
  {
    id: 'auto-install.team',
    area: 'Auto-install',
    routes: [
      'POST /auto-install-policies',
      'PATCH /auto-install-policies/{id}',
      'DELETE /auto-install-policies/{id}',
      'POST /auto-install-policies/{id}/preview',
    ],
    action: 'policy.edit',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    note: 'Policies that target team T only.',
  },
  {
    id: 'auto-install.org',
    area: 'Auto-install',
    routes: [
      'POST /auto-install-policies',
      'PATCH /auto-install-policies/{id}',
      'DELETE /auto-install-policies/{id}',
      'POST /auto-install-policies/{id}/preview',
    ],
    action: 'policy.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
    note: 'Policies that target all users, roles or IdP groups.',
  },
  // --- Registry ----------------------------------------------------------------------------------------
  {
    id: 'registry.sources.write',
    area: 'Registry',
    routes: [
      'POST /registry-sources',
      'PATCH /registry-sources/{id}',
      'DELETE /registry-sources/{id}',
      'POST /registry-sources/{id}/sync',
      'PUT /registry-sources/{id}/policy',
    ],
    action: 'settings.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'registry.install',
    area: 'Registry',
    routes: [
      'GET /registry/servers',
      'GET /registry/servers/{sourceId}/{name}/{version}',
      'POST /registry/install',
      'GET /install-requests',
      'POST /install-requests',
    ],
    action: 'registry.install',
    resource: 'Org',
    grants: g('allow', 'allow', 'allow', 'deny'),
    serviceAccount: 'deny',
    note: 'The registry source policy (11.7) is not Cedar and narrows this further.',
  },
  {
    id: 'registry.requests.decide',
    area: 'Registry',
    routes: ['POST /install-requests/{id}/approve', 'POST /install-requests/{id}/reject'],
    action: 'registry.install',
    resource: 'User',
    grants: g('allow', 'scoped', 'deny', 'deny'),
    serviceAccount: 'deny',
    note: 'The resource is the requester; managers decide for members of their teams.',
  },
  // --- Policies, guards, limits ------------------------------------------------------------------------------
  {
    id: 'policies.write',
    area: 'Policies',
    routes: [
      'POST /policy-rules',
      'PATCH /policy-rules/{id}',
      'DELETE /policy-rules/{id}',
      'POST /custom-policies',
      'PATCH /custom-policies/{id}',
      'DELETE /custom-policies/{id}',
      'POST /policies/validate',
      'POST /policies/simulate',
    ],
    action: 'policy.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'guards.write',
    area: 'Guards',
    routes: [
      'POST /guard-profiles',
      'PATCH /guard-profiles/{id}',
      'DELETE /guard-profiles/{id}',
      'POST /guard-profiles/{id}/test',
      'PUT /settings/model-guards',
    ],
    action: 'guard.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'limits.write',
    area: 'Limits',
    routes: ['POST /limit-rules', 'PATCH /limit-rules/{id}', 'DELETE /limit-rules/{id}'],
    action: 'settings.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  // --- Secrets -------------------------------------------------------------------------------------------
  {
    id: 'secrets.org',
    area: 'Secrets',
    routes: [
      'GET /secrets?scope=org',
      'PUT /secrets/org/{ownerId}/{name}',
      'DELETE /secrets/org/{ownerId}/{name}',
    ],
    action: 'secrets.manage',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
  {
    id: 'secrets.team',
    area: 'Secrets',
    routes: [
      'GET /secrets?scope=team',
      'PUT /secrets/team/{ownerId}/{name}',
      'DELETE /secrets/team/{ownerId}/{name}',
    ],
    action: 'secrets.manage',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'deny'),
  },
  {
    id: 'secrets.user',
    area: 'Secrets',
    routes: [
      'GET /secrets?scope=user',
      'PUT /secrets/user/{ownerId}/{name}',
      'DELETE /secrets/user/{ownerId}/{name}',
    ],
    action: 'secrets.manage',
    resource: 'User',
    grants: g('scoped', 'scoped', 'scoped', 'scoped'),
    serviceAccount: 'deny',
    note: 'Own user secrets only; an auditor never sees org or team values.',
  },
  // --- Observability and audit ---------------------------------------------------------------------------
  {
    id: 'logs.org',
    area: 'Observability',
    routes: [
      'GET /calls',
      'GET /calls/{id}',
      'GET /stats/calls',
      'GET /stats/latency',
      'GET /stats/guards',
      'GET /stats/sandboxes',
      'GET /security/findings',
    ],
    action: 'logs.view',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'allow'),
    note: "All users' calls.",
  },
  {
    id: 'logs.team',
    area: 'Observability',
    routes: ['GET /calls?team=', 'GET /stats/calls?team='],
    action: 'logs.view',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'allow'),
    note: 'Managers only when `logs.managerVisibility` is on.',
  },
  {
    id: 'logs.user',
    area: 'Observability',
    routes: ['GET /calls?user=', 'GET /calls/{id}', 'GET /stats/calls?user='],
    action: 'logs.view',
    resource: 'User',
    grants: g('allow', 'scoped', 'scoped', 'allow'),
    serviceAccount: 'deny',
    note: 'The resource is the caller whose call is shown; members see their own.',
  },
  {
    id: 'audit.org',
    area: 'Audit',
    routes: ['GET /audit', 'GET /audit/export', 'GET /audit/verify'],
    action: 'audit.view',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'allow'),
  },
  {
    id: 'audit.team',
    area: 'Audit',
    routes: ['GET /audit?team='],
    action: 'audit.view',
    resource: 'Team',
    grants: g('allow', 'scoped', 'deny', 'allow'),
    note: 'T-scoped events for managers.',
  },
  // --- Settings and system -------------------------------------------------------------------------------
  {
    id: 'settings.write',
    area: 'Settings and system',
    routes: ['PATCH /settings', 'POST /system/kms/rotate', 'POST /system/signing-keys/rotate'],
    action: 'settings.edit',
    resource: 'Org',
    grants: g('allow', 'deny', 'deny', 'deny'),
  },
];
