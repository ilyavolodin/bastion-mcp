import type {
  CallRecord,
  DriftReview,
  EgressHost,
  Endpoint,
  Installation,
  InstallRequest,
  Marketplace,
  MarketplaceDetail,
  Me,
  OverrideDocument,
  RegistryServer,
  Team,
  UiRole,
  User,
} from '@/api/types';
import { type AccessData, buildAccessData } from './domains/access';
import { buildCatalogData, type CatalogData } from './domains/catalog';
import { buildObservabilityData, type ObservabilityData } from './domains/observability';
import { buildPluginsData, type PluginsData } from './domains/plugins';
import { buildRegistryData, type RegistryData } from './domains/registry';
import { buildServersData, type ServersData } from './domains/servers';
import { buildSessionData, type SessionData } from './domains/session';
import { buildSettingsData, type SettingsData } from './domains/settings';
import * as fx from './fixtures';

/**
 * Rows in the shape of the real API (generated types), one slice per domain (`./domains/*`). Domains that moved to
 * the typed mock read and write `db.data.<domain>`; the flat view-model fields below belong to the screens that
 * have not moved yet and disappear with them.
 */
export type DomainData = {
  access: AccessData;
  settings: SettingsData;
  catalog: CatalogData;
  servers: ServersData;
  observability: ObservabilityData;
  registry: RegistryData;
  plugins: PluginsData;
  session: SessionData;
};

export type MockDb = {
  data: DomainData;
  now: number;
  role: UiRole;
  me: Me;
  users: User[];
  teams: Team[];
  installations: Installation[];
  endpoints: Endpoint[];
  calls: CallRecord[];
  drift: DriftReview[];
  requests: InstallRequest[];
  registry: RegistryServer[];
  marketplaces: Marketplace[];
  marketplaceDetails: Record<string, MarketplaceDetail>;
  overrides: Record<string, OverrideDocument>;
  egress: Record<string, { hosts: EgressHost[] }>;
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
  const marketplaces = fx.buildMarketplaces();
  return {
    data: {
      access: buildAccessData(now),
      settings: buildSettingsData(now),
      catalog: buildCatalogData(now),
      servers: buildServersData(now),
      observability: buildObservabilityData(now),
      registry: buildRegistryData(now),
      plugins: buildPluginsData(now),
      session: buildSessionData(now),
    },
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
    drift: fx.buildDrift(now),
    requests: fx.buildRequests(now),
    registry: fx.buildRegistry(),
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
        },
      ]),
    ),
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
