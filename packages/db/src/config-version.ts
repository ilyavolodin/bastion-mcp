import type { DbExecutor } from './client';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Bumps `config_versions(scope, scope_id)` and returns the new version (4.3). The ui role publishes
 * `{scope, id, version}` on `bastion:config` after the surrounding transaction commits.
 */
export const bumpConfigVersion = async (
  db: DbExecutor,
  scope: string,
  scopeId: string = NIL_UUID,
): Promise<bigint> => {
  const rows = await db.$queryRaw<{ version: bigint }[]>`
    INSERT INTO config_versions (scope, scope_id, version)
    VALUES (${scope}, ${scopeId}::uuid, 1)
    ON CONFLICT (scope, scope_id) DO UPDATE SET version = config_versions.version + 1
    RETURNING version`;
  return (rows[0] as { version: bigint }).version;
};

export const getConfigVersion = async (
  db: DbExecutor,
  scope: string,
  scopeId: string = NIL_UUID,
): Promise<bigint> => {
  const rows = await db.$queryRaw<{ version: bigint }[]>`
    SELECT version FROM config_versions WHERE scope = ${scope} AND scope_id = ${scopeId}::uuid`;
  return rows[0]?.version ?? 0n;
};
