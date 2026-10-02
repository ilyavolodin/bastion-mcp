import { ORG_SETTING_DEFAULTS, type OrgSettings } from '@bastion-mcp/core/org-settings';
import type {
  AutoInstallPolicy,
  CallRecord,
  CatalogEntry,
  CatalogVersion,
  CustomPolicy,
  DriftReview,
  EgressHost,
  EgressRequest,
  Endpoint,
  FileNode,
  IdpConnection,
  Installation,
  InstallRequest,
  LimitRule,
  Marketplace,
  MarketplaceDetail,
  Me,
  ModelGuardConfig,
  Notification,
  OAuthClient,
  OverrideDocument,
  PolicyRule,
  RegistryServer,
  RoleMappingRule,
  ServiceAccount,
  SkillFile,
  Team,
  UiRole,
  User,
} from '@/api/types';
import * as fx from './fixtures';

export type MockDb = {
  now: number;
  role: UiRole;
  me: Me;
  users: User[];
  teams: Team[];
  installations: Installation[];
  endpoints: Endpoint[];
  calls: CallRecord[];
  notifications: Notification[];
  catalog: CatalogEntry[];
  versions: Record<string, CatalogVersion[]>;
  autoInstall: AutoInstallPolicy[];
  drift: DriftReview[];
  requests: InstallRequest[];
  registry: RegistryServer[];
  roleMapping: RoleMappingRule[];
  serviceAccounts: ServiceAccount[];
  oauthClients: OAuthClient[];
  policyRules: PolicyRule[];
  customPolicies: CustomPolicy[];
  idp: IdpConnection[];
  modelGuards: ModelGuardConfig;
  limits: LimitRule[];
  settings: OrgSettings;
  marketplaces: Marketplace[];
  marketplaceDetails: Record<string, MarketplaceDetail>;
  overrides: Record<string, OverrideDocument>;
  egress: Record<string, { hosts: EgressHost[]; requests: EgressRequest[] }>;
  files: { nodes: FileNode[]; files: Record<string, SkillFile> };
  testStarts: Record<string, number>;
  seq: number;
};

export const buildMe = (role: UiRole): Me => {
  const orgRole = role === 'admin' ? 'admin' : role === 'auditor' ? 'auditor' : 'member';
  return {
    id: 'u-dana',
    email: 'dana.whitfield@acme.dev',
    name: 'Dana Whitfield',
    orgRole,
    teams: [
      {
        id: 't-platform',
        name: 'Platform team',
        role: role === 'member' || role === 'auditor' ? 'member' : 'manager',
      },
    ],
    theme: 'light',
    org: {
      name: 'Acme Corp',
      host: fx.HOST,
      traceUiUrl: 'https://traces.acme.dev/trace',
      toolWarnThreshold: 40,
    },
    capabilities: {
      registry: role !== 'auditor',
      publishOrgWide: role === 'admin',
      personalInstalls: 'remoteOnly',
    },
  };
};

export function createDb(role: UiRole = 'admin', now: number = Date.now()): MockDb {
  const users = fx.buildUsers(now);
  const installations = fx.buildInstallations();
  const catalog = fx.buildCatalog();
  const settings: OrgSettings = {
    ...ORG_SETTING_DEFAULTS,
    org: { displayName: 'Acme Corp', timeZone: 'America/New_York' },
    endpoints: { toolWarnThreshold: 40 },
    logs: { ...ORG_SETTING_DEFAULTS.logs, capturePreviews: true },
  };
  const marketplaces = fx.buildMarketplaces();
  return {
    now,
    role,
    me: buildMe(role),
    users,
    teams: fx.buildTeams(),
    installations,
    endpoints: [
      {
        id: 'e-default',
        slug: 'default',
        name: 'Everything',
        url: `https://${fx.HOST}/mcp`,
        isDefault: true,
        installationIds: installations.filter((i) => i.status === 'ready').map((i) => i.id),
        toolCount: 41,
        updatedAt: new Date(now - DAYS(2)).toISOString(),
      },
      {
        id: 'e-eng',
        slug: 'engineering',
        name: 'Engineering',
        url: `https://${fx.HOST}/mcp/c/engineering`,
        isDefault: false,
        installationIds: ['i-github', 'i-jira', 'i-linear'],
        toolCount: 20,
        updatedAt: new Date(now - DAYS(9)).toISOString(),
      },
    ],
    calls: fx.buildCalls(now, users, installations),
    notifications: fx.buildNotifications(now),
    catalog,
    versions: Object.fromEntries(catalog.map((e) => [e.id, fx.buildVersions(e)])),
    autoInstall: fx.buildAutoInstall(),
    drift: fx.buildDrift(now),
    requests: fx.buildRequests(now),
    registry: fx.buildRegistry(),
    roleMapping: fx.buildRoleMapping(),
    serviceAccounts: fx.buildServiceAccounts(now),
    oauthClients: fx.buildOAuthClients(now),
    policyRules: fx.buildPolicyRules(),
    customPolicies: fx.buildCustomPolicies(),
    idp: fx.buildIdp(now),
    modelGuards: fx.buildModelGuards(),
    limits: fx.buildLimits(),
    settings,
    marketplaces,
    marketplaceDetails: Object.fromEntries(
      marketplaces.map((m) => [m.id, fx.buildMarketplaceDetail(m, now)]),
    ),
    overrides: {
      'i-postgres': {
        version: 1,
        tools: {
          pg_run_query: {
            description: { mode: 'append', text: 'Queries run on the analytics replica.' },
            annotations: { readOnlyHint: true },
          },
          pg_describe_table: { title: 'Describe a table' },
          pg_write_rows: { hidden: true },
        },
      },
    },
    egress: Object.fromEntries(
      installations.map((i) => [
        i.id,
        {
          hosts: (
            fx.buildStoreEntry(i.slug === 'pg-analytics' ? 'postgres' : i.slug, new Set())
              ?.egressHosts ?? []
          )
            .map(
              (host): EgressHost => ({
                host,
                status: 'allowed',
                reason: 'Declared by the catalog entry',
                lastSeenAt: new Date(now - 3_600_000).toISOString(),
              }),
            )
            .concat(
              i.runtime === 'npm'
                ? [
                    {
                      host: 'registry.npmjs.org',
                      status: 'allowed',
                      reason: 'Package install',
                      lastSeenAt: null,
                    },
                    {
                      host: 'telemetry.example.net',
                      status: 'denied',
                      reason: 'Not on the allowlist',
                      lastSeenAt: new Date(now - 7_200_000).toISOString(),
                    },
                  ]
                : [],
            ),
          requests: [],
        },
      ]),
    ),
    files: fx.buildSkillFiles(),
    testStarts: {},
    seq: 100,
  };
}

const DAYS = (n: number) => n * 86_400_000;

let current = createDb();
export const getDb = (): MockDb => current;
export const resetDb = (role: UiRole = 'admin', now: number = Date.now()): MockDb => {
  current = createDb(role, now);
  return current;
};
export const setRole = (role: UiRole): void => {
  if (current.role !== role) {
    current.role = role;
    current.me = buildMe(role);
  }
};
export const nextId = (prefix: string): string => `${prefix}-${++current.seq}`;
