/**
 * `bastion migrate` (20.1): applies the Prisma migrations of `packages/db/prisma/migrations` without the Prisma CLI.
 * The runtime image carries only production dependencies, so the CLI is not available; this runner is compatible
 * with `prisma migrate deploy`: it uses the same `_prisma_migrations` table and checksums (sha256 of the SQL file),
 * so either tool can continue where the other stopped. Migrations are applied in name order, each in its own
 * transaction, under a session advisory lock so concurrent starts do not race.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@bastion-mcp/core';
import pg from 'pg';

const LOCK_KEY = 7_201_777;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export type BundledMigration = { name: string; sql: string; checksum: string };

/** Where the SQL lives: `BASTION_MIGRATIONS_DIR`, `<app>/prisma/migrations` (image, build), or the repo checkout. */
export const migrationsDir = (env: Record<string, string | undefined> = process.env): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.BASTION_MIGRATIONS_DIR,
    join(here, '..', 'prisma', 'migrations'),
    join(here, '..', '..', 'prisma', 'migrations'),
    join(here, '..', '..', '..', '..', 'packages', 'db', 'prisma', 'migrations'),
  ].filter((p): p is string => typeof p === 'string');
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`migrations directory not found (tried ${candidates.join(', ')})`);
  return found;
};

export const bundledMigrations = (dir = migrationsDir()): BundledMigration[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });

export type MigrationStatus = { applied: string[]; pending: string[]; failed: string[] };

const hasTable = async (client: pg.Client | pg.Pool): Promise<boolean> => {
  const res = await client.query(`SELECT to_regclass('public._prisma_migrations') AS t`);
  return res.rows[0]?.t !== null;
};

/** Compares applied migrations to the bundled ones (readiness check, boot guard). */
export const migrationStatus = async (
  client: pg.Client | pg.Pool,
  dir = migrationsDir(),
): Promise<MigrationStatus> => {
  const bundled = bundledMigrations(dir);
  const done = new Set<string>();
  const failed: string[] = [];
  if (await hasTable(client)) {
    const res = await client.query(
      `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
    );
    for (const row of res.rows) {
      if (row.finished_at && !row.rolled_back_at) done.add(row.migration_name);
      else if (!row.finished_at) failed.push(row.migration_name);
    }
  }
  return {
    applied: bundled.filter((m) => done.has(m.name)).map((m) => m.name),
    pending: bundled.filter((m) => !done.has(m.name)).map((m) => m.name),
    failed,
  };
};

export type MigrateResult = { applied: string[]; alreadyApplied: number };

export const migrate = async (
  databaseUrl: string,
  options: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrateResult> => {
  const log = options.log ?? (() => undefined);
  const migrations = bundledMigrations(options.dir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(CREATE_TABLE);
    const existing = await client.query(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`,
    );
    const byName = new Map(existing.rows.map((r) => [r.migration_name as string, r]));
    let already = 0;
    for (const m of migrations) {
      const row = byName.get(m.name);
      if (row?.finished_at && !row.rolled_back_at) {
        if (row.checksum !== m.checksum) {
          throw new Error(`migration ${m.name} was modified after it was applied`);
        }
        already += 1;
        continue;
      }
      if (row && !row.finished_at) {
        throw new Error(
          `migration ${row.migration_name} failed earlier; resolve it before migrating`,
        );
      }
      log(`applying ${m.name}`);
      const id = newId();
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ($1,$2,$3,now(),0)`,
          [id, m.checksum, m.name],
        );
        await client.query(m.sql);
        await client.query(
          `UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1`,
          [id],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `migration ${m.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      applied.push(m.name);
    }
    return { applied, alreadyApplied: already };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
};
