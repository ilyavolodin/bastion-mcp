import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTO_INSTALL_MODES,
  AUTO_INSTALL_SCOPES,
  CALL_OUTCOMES,
  CATALOG_KINDS,
  CATALOG_STATUSES,
  CATALOG_VERSION_STATUSES,
  DESKTOP_INSTALLATION_MODES,
  DISTRIBUTION_CHANNELS,
  DRIFT_POLICIES,
  FILE_CLASSIFICATIONS,
  FILE_MODES,
  INSTALLATION_STATUSES,
  INSTANCE_KINDS,
  ITEM_KINDS,
  LIMIT_KINDS,
  MARKETPLACE_ITEM_POLICIES,
  MEMBERSHIP_SOURCES,
  ORG_ROLES,
  OWNER_TYPES,
  POLICY_EFFECTS,
  PRINCIPAL_TYPES,
  REQUEST_STATUSES,
  REVIEW_STATUSES,
  RISK_LEVELS,
  SECRET_SCOPES,
  SIGNING_KEY_PURPOSES,
  TEAM_ROLES,
  UPSTREAM_TOKEN_STATUSES,
  USER_OVERRIDE_LEVELS,
  USER_STATUSES,
} from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', 'prisma');
const migrationsDir = join(root, 'migrations');
/** Every migration in order: CHECKs may be added or replaced by later ones. */
const migration = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'))
  .join('\n');
const schema = readFileSync(join(root, 'schema.prisma'), 'utf8');

/** Extracts `column IN ('a','b')` from `ALTER TABLE t ADD CONSTRAINT ... CHECK (...)`. */
const checkValues = (table: string, column: string): string[] => {
  const re = new RegExp(
    `ALTER TABLE "${table}" ADD CONSTRAINT "[^"]+" CHECK \\(${column} in \\(([^)]*)\\)\\);`,
    'i',
  );
  const match = re.exec(migration);
  if (!match) throw new Error(`no CHECK constraint on ${table}.${column}`);
  return [...(match[1] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
};

describe('16.2 schema conformance: CHECK constraints mirror @bastion-mcp/core constants', () => {
  const cases: [string, string, readonly string[]][] = [
    ['users', 'org_role', ORG_ROLES],
    ['users', 'status', USER_STATUSES],
    ['team_memberships', 'role', TEAM_ROLES],
    ['team_memberships', 'source', MEMBERSHIP_SOURCES],
    ['signing_keys', 'purpose', SIGNING_KEY_PURPOSES],
    ['secrets', 'scope', SECRET_SCOPES],
    ['catalog_entries', 'kind', CATALOG_KINDS],
    ['catalog_entries', 'status', CATALOG_STATUSES],
    ['catalog_entries', 'risk', RISK_LEVELS],
    ['catalog_entries', 'user_overrides', USER_OVERRIDE_LEVELS],
    ['catalog_entries', 'on_drift', DRIFT_POLICIES],
    ['catalog_versions', 'status', CATALOG_VERSION_STATUSES],
    ['definition_pins', 'item_kind', ITEM_KINDS],
    ['drift_reviews', 'status', REVIEW_STATUSES],
    ['limit_rules', 'kind', LIMIT_KINDS],
    ['policy_rules', 'effect', POLICY_EFFECTS],
    ['installations', 'owner_type', OWNER_TYPES],
    ['installations', 'status', INSTALLATION_STATUSES],
    ['instances', 'kind', INSTANCE_KINDS],
    ['upstream_tokens', 'status', UPSTREAM_TOKEN_STATUSES],
    ['auto_install_policies', 'mode', AUTO_INSTALL_MODES],
    ['auto_install_policies', 'scope', AUTO_INSTALL_SCOPES],
    ['install_requests', 'status', REQUEST_STATUSES],
    ['egress_access_requests', 'status', REVIEW_STATUSES],
    ['catalog_files', 'mode', FILE_MODES],
    ['catalog_files', 'classification', FILE_CLASSIFICATIONS],
    ['marketplaces', 'desktop_installation', DESKTOP_INSTALLATION_MODES],
    ['marketplace_items', 'policy', MARKETPLACE_ITEM_POLICIES],
    ['distribution_events', 'channel', DISTRIBUTION_CHANNELS],
    // 0002_repositories
    ['service_accounts', 'status', ['active', 'disabled']],
    ['service_accounts', 'auth_method', ['client_secret_basic', 'private_key_jwt']],
    ['personal_access_tokens', 'principal_type', PRINCIPAL_TYPES],
    ['upstream_tokens', 'principal_type', PRINCIPAL_TYPES],
    ['endpoints', 'prefix_mode', ['always', 'onCollision']],
    ['upstream_clients', 'registration', ['preRegistered', 'cimd', 'dcr']],
    ['auto_install_applications', 'subject_type', ['user', 'team']],
    ['egress_events', 'decision', ['allow', 'deny']],
    ['call_log', 'outcome', CALL_OUTCOMES],
    ['call_log', 'principal_type', PRINCIPAL_TYPES],
    ['registry_sources', 'trust', ['official', 'internal', 'community']],
    ['registry_servers', 'status', ['active', 'deprecated', 'deleted']],
  ];

  it.each(cases)('%s.%s', (table, column, expected) => {
    expect(checkValues(table, column)).toEqual([...expected]);
  });
});

describe('16.2 schema conformance: structure', () => {
  const tables = [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1] as string);

  it('creates every table of section 16.2', () => {
    const expected = [
      'org_settings',
      'idp_connections',
      'users',
      'teams',
      'team_memberships',
      'role_mapping_rules',
      'service_accounts',
      'personal_access_tokens',
      'oidc_models',
      'signing_keys',
      'idp_tokens',
      'secrets',
      'catalog_entries',
      'catalog_versions',
      'upstream_snapshots',
      'definition_pins',
      'drift_reviews',
      'guard_profiles',
      'limit_rules',
      'policy_rules',
      'custom_policies',
      'installations',
      'installation_prefs',
      'endpoints',
      'instances',
      'upstream_clients',
      'upstream_tokens',
      'auto_install_policies',
      'auto_install_applications',
      'registry_sources',
      'registry_servers',
      'registry_policies',
      'install_requests',
      'call_log',
      'call_stats_minute',
      'call_stats_hour',
      'call_stats_day',
      'egress_events',
      'audit_events',
      'notifications',
      'scim_tokens',
      'oauth_client_policies',
      'egress_access_requests',
      'blobs',
      'catalog_files',
      'executable_approvals',
      'plugin_sources',
      'marketplaces',
      'marketplace_items',
      'marketplace_releases',
      'distribution_events',
      'config_versions',
    ];
    expect([...tables].sort()).toEqual([...expected].sort());
  });

  it('partitions the telemetry tables by day range (15.5)', () => {
    for (const table of ['call_log', 'egress_events', 'distribution_events']) {
      expect(migration).toMatch(
        new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\) PARTITION BY RANGE \\("ts"\\);`),
      );
    }
  });

  it('creates citext for users.email', () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS citext;');
    expect(migration).toMatch(/"email" CITEXT NOT NULL/);
  });

  it('every model maps to a snake_case table', () => {
    const models = [...schema.matchAll(/^model (\w+) \{[\s\S]*?^\}/gm)];
    expect(models.length).toBe(tables.length);
    for (const model of models) expect(model[0]).toMatch(/@@map\("[a-z_]+"\)/);
  });

  it('keeps the spec rule that installations carry a catalog entry XOR a personal spec', () => {
    expect(migration).toMatch(/installations_catalog_xor_personal_check/);
  });
});
