/**
 * Which tables a full backup (`bastion backup`) carries. Every table of the `public` schema must appear in exactly one of
 * `BACKUP_TABLES` or `EXCLUDED_TABLES`: `test/backup-tables.integration.test.ts` compares both lists with the migrated
 * database, so a new table fails CI until somebody decides whether it belongs in a backup.
 */

export type BackupTable = {
  name: string;
  /**
   * `replace` tables are only restored by a replace: merging them would break their integrity (the audit log is a hash
   * chain; signing keys of the backup would sit next to the keys the target created for itself).
   */
  restore?: 'always' | 'replace';
};

/** Parents before children: the order of inserts. Deletes (replace) run in reverse. */
export const BACKUP_TABLES: readonly BackupTable[] = [
  { name: 'org_settings' },
  // Envelope-encrypted values: the data key travels in the (passphrase-sealed) backup, not wrapped by this KMS.
  { name: 'secrets' },
  { name: 'idp_connections' },
  { name: 'users' },
  { name: 'teams' },
  { name: 'team_memberships' },
  { name: 'role_mapping_rules' },
  { name: 'service_accounts' },
  { name: 'personal_access_tokens' },
  { name: 'scim_tokens' },
  { name: 'oidc_models' },
  { name: 'oauth_client_policies' },
  { name: 'signing_keys', restore: 'replace' },
  { name: 'idp_tokens' },
  { name: 'guard_profiles' },
  { name: 'blobs' },
  { name: 'catalog_entries' },
  { name: 'catalog_versions' },
  { name: 'catalog_files' },
  { name: 'executable_approvals' },
  { name: 'upstream_snapshots' },
  { name: 'definition_pins' },
  { name: 'drift_reviews' },
  { name: 'limit_rules' },
  { name: 'policy_rules' },
  { name: 'custom_policies' },
  { name: 'installations' },
  { name: 'installation_prefs' },
  { name: 'endpoints' },
  { name: 'upstream_clients' },
  { name: 'upstream_tokens' },
  { name: 'egress_access_requests' },
  { name: 'auto_install_policies' },
  { name: 'auto_install_applications' },
  { name: 'registry_sources' },
  { name: 'registry_policies' },
  { name: 'install_requests' },
  { name: 'plugin_sources' },
  { name: 'marketplaces' },
  { name: 'marketplace_items' },
  { name: 'marketplace_releases' },
  { name: 'audit_events', restore: 'replace' },
];

/** Tables a backup leaves out, with the reason; partitions of these are matched by prefix. */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations: 'schema bookkeeping of this database',
  call_log: 'high-volume call history (daily partitions)',
  call_stats_minute: 'derived statistics',
  call_stats_hour: 'derived statistics',
  call_stats_day: 'derived statistics',
  egress_events: 'high-volume network history (daily partitions)',
  distribution_events: 'high-volume download history (daily partitions)',
  notifications: 'transient per-user notices',
  instances: 'runtime state of sandboxes, rebuilt on demand',
  registry_servers:
    'cache of servers synced from the registry sources (hundreds of MB for a public registry); the next sync rebuilds it',
  config_versions: 'change counters; bumped after a restore so every worker reloads',
};

/** A partition of `call_log`, `egress_events` or `distribution_events` (`call_log_20261022`). */
export const isExcludedPartition = (table: string): boolean =>
  Object.keys(EXCLUDED_TABLES).some((base) => new RegExp(`^${base}_\\d{8}$`).test(table));

export const SECRETS_TABLE = 'secrets';
export const SIGNING_KEYS_TABLE = 'signing_keys';
export const AUDIT_TABLE = 'audit_events';
