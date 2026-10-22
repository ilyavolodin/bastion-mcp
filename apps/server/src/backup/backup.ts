/**
 * Full backup and restore (`bastion backup` / `bastion restore`, the console and `/api/v1/system/backup`).
 *
 * Unlike `export-config` (declarative, secret-free, for promotion between environments) a backup is a complete copy of
 * what the instance would lose in a disaster: configuration, catalog, users and teams, installations with their
 * per-user settings, OAuth connections and tokens, token hashes, the audit log and every stored secret.
 *
 * Tables are copied generically through Postgres JSON functions (`to_jsonb` out, `jsonb_populate_recordset` in), so a
 * column added by a migration is backed up without touching this file. Secrets are the one exception: each is sealed
 * with its own data key, wrapped by the KMS. The backup carries the data key itself (the whole file is sealed with the
 * operator's passphrase, see `sealed-file.ts`) and the ciphertext untouched; a restore wraps the data key with the KMS of
 * the target, so a backup restores on an installation with a different KMS key. Ids are preserved, which matters because
 * a dozen columns refer to a secret by id.
 */
import { newId } from '@bastion-mcp/core';
import { appendAuditEvent, bumpConfigVersion, NIL_UUID, type Prisma } from '@bastion-mcp/db';
import { z } from 'zod';
import type { Infra } from '../infra';
import { BACKUP_TX_OPTIONS } from '../timing';
import type { Maintenance } from './maintenance';
import { type BackupHeader, openBackup, sealBackup } from './sealed-file';
import {
  AUDIT_TABLE,
  BACKUP_TABLES,
  type BackupTable,
  SECRETS_TABLE,
  SIGNING_KEYS_TABLE,
} from './tables';

type Row = Record<string, unknown>;
type Queryable = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export class RestoreRefusedError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'newer_schema' | 'maintenance_required' | 'unsafe' | 'conflict',
  ) {
    super(message);
  }
}

const PAGE_ROWS = 500;
/** `blobs` rows can be large; read and write them in small pages. */
const PAGE_ROWS_BY_TABLE: Record<string, number> = { blobs: 20 };
const pageRows = (table: string): number => PAGE_ROWS_BY_TABLE[table] ?? PAGE_ROWS;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const hexToBuffer = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !value.startsWith('\\x')) {
    throw new RestoreRefusedError('a secret row has a malformed binary value', 'invalid');
  }
  return Buffer.from(value.slice(2), 'hex');
};
const bufferToHex = (value: Buffer): string => `\\x${value.toString('hex')}`;

const tableColumns = async (db: Queryable, table: string): Promise<string[]> =>
  (
    await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      table,
    )
  ).map((r) => r.column_name);

const primaryKey = async (db: Queryable, table: string): Promise<string[]> => {
  const rows = await db.$queryRawUnsafe<{ attname: string }[]>(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = to_regclass($1) AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    `public.${quote(table)}`,
  );
  if (rows.length === 0) throw new Error(`table ${table} has no primary key`);
  return rows.map((r) => r.attname);
};

/** A unique index other than the primary key (plain columns only; expression indexes are left to the database). */
type UniqueKey = { columns: string[]; predicate: string | null };

const uniqueKeys = async (db: Queryable, table: string): Promise<UniqueKey[]> => {
  const rows = await db.$queryRawUnsafe<{ cols: string[]; pred: string | null }[]>(
    `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols, pg_get_expr(i.indpred, i.indrelid) AS pred
       FROM pg_index i
       CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = to_regclass($1) AND i.indisunique AND NOT i.indisprimary AND i.indexprs IS NULL
      GROUP BY i.indexrelid, i.indrelid, i.indpred`,
    `public.${quote(table)}`,
  );
  return rows.map((r) => ({ columns: r.cols, predicate: r.pred }));
};

/**
 * Rows of this installation that a merge would collide with: same unique key (an email, a slug, a name) as a backup
 * row, different primary key. The upsert only matches on the primary key, so these have to go first.
 */
const clashFrom = (table: string, key: UniqueKey, pk: string[]): string => {
  const where = key.predicate ? ` WHERE ${key.predicate}` : '';
  const same = key.columns.map((c) => `x.${quote(c)} = b.${quote(c)}`).join(' AND ');
  const differs = pk.map((c) => `x.${quote(c)} IS DISTINCT FROM b.${quote(c)}`).join(' OR ');
  return `FROM (SELECT ctid AS row_id, * FROM ${quote(table)}${where}) x
          JOIN (SELECT * FROM jsonb_populate_recordset(NULL::${quote(table)}, $1::jsonb)${where}) b
            ON ${same} AND (${differs})`;
};

type Clash = { key: string; count: number; ids: string[] };

const findClashes = async (db: Queryable, table: string, rows: Row[]): Promise<Clash[]> => {
  if (rows.length === 0) return [];
  const pk = await primaryKey(db, table);
  const size = pageRows(table);
  const out: Clash[] = [];
  for (const key of await uniqueKeys(db, table)) {
    const seen = new Map<string, string>();
    for (let i = 0; i < rows.length; i += size) {
      const found = await db.$queryRawUnsafe<{ row_id: string; id: string | null }[]>(
        `SELECT DISTINCT x.row_id::text AS row_id, to_jsonb(x)->>'id' AS id ${clashFrom(table, key, pk)}`,
        JSON.stringify(rows.slice(i, i + size)),
      );
      for (const f of found) seen.set(f.row_id, f.id ?? '');
    }
    if (seen.size > 0)
      out.push({ key: key.columns.join(' + '), count: seen.size, ids: [...seen.values()] });
  }
  return out;
};

const removeClashes = async (db: Queryable, table: string, rows: Row[]): Promise<void> => {
  if (rows.length === 0) return;
  const pk = await primaryKey(db, table);
  const size = pageRows(table);
  for (const key of await uniqueKeys(db, table)) {
    for (let i = 0; i < rows.length; i += size) {
      await db.$executeRawUnsafe(
        `DELETE FROM ${quote(table)} WHERE ctid IN (SELECT x.row_id ${clashFrom(table, key, pk)})`,
        JSON.stringify(rows.slice(i, i + size)),
      );
    }
  }
};

const lastMigration = async (db: Queryable): Promise<string | null> => {
  const rows = await db.$queryRawUnsafe<{ migration_name: string }[]>(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1',
  );
  return rows[0]?.migration_name ?? null;
};

// --- export ----------------------------------------------------------------------------------------------------

const readTable = async (db: Queryable, table: string): Promise<Row[]> => {
  const order = (await primaryKey(db, table)).map(quote).join(', ');
  const size = pageRows(table);
  const out: Row[] = [];
  for (let offset = 0; ; offset += size) {
    const page = await db.$queryRawUnsafe<{ r: Row }[]>(
      `SELECT to_jsonb(t) AS r FROM ${quote(table)} t ORDER BY ${order} LIMIT ${size} OFFSET ${offset}`,
    );
    out.push(...page.map((p) => p.r));
    if (page.length < size) return out;
  }
};

/** Replaces the KMS-wrapped data key with the data key itself; the file is sealed as a whole. */
const openSecretRow = async (infra: Infra, row: Row): Promise<Row> => {
  const { wrapped_dek: wrapped, kek_ref: kekRef, ...rest } = row;
  try {
    const dek = await infra.kms.unwrap(hexToBuffer(wrapped), String(kekRef));
    try {
      return { ...rest, dek: dek.toString('base64') };
    } finally {
      dek.fill(0);
    }
  } catch (error) {
    throw new Error(
      `cannot read secret ${String(row.id)} (${String(row.scope)}/${String(row.name)}) with the KMS: ${
        error instanceof Error ? error.message : String(error)
      }. A backup that cannot include every secret is not created.`,
    );
  }
};

export type BackupReport = { file: Buffer; counts: Record<string, number>; createdAt: Date };

export const createBackup = async (
  infra: Infra,
  passphrase: string,
  actor: { id: string | null },
): Promise<BackupReport> => {
  const createdAt = new Date();
  let migration: string | null = null;
  const tables: Record<string, Row[]> = {};
  // One snapshot for every table, so rows that refer to each other agree.
  await infra.db.prisma.$transaction(
    async (tx) => {
      migration = await lastMigration(tx);
      for (const table of BACKUP_TABLES) {
        const rows = await readTable(tx, table.name);
        tables[table.name] =
          table.name === SECRETS_TABLE
            ? await Promise.all(rows.map((r) => openSecretRow(infra, r)))
            : rows;
      }
    },
    { ...BACKUP_TX_OPTIONS, isolationLevel: 'RepeatableRead' },
  );
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  const file = await sealBackup(
    { format: 1, createdAt: createdAt.toISOString(), migration, tables },
    passphrase,
    { createdAt, migration },
  );
  // The export carries every secret: it is audited like the restore is.
  await infra.db.prisma.$transaction((tx) =>
    appendAuditEvent(tx, {
      actorType: actor.id ? 'user' : 'system',
      actorId: actor.id,
      action: 'backup.export',
      targetType: 'backup',
      diff: { counts, bytes: file.length },
    }),
  );
  return { file, counts, createdAt };
};

// --- restore ---------------------------------------------------------------------------------------------------

const documentSchema = z.object({
  format: z.literal(1),
  createdAt: z.string(),
  migration: z.string().nullable(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
type BackupDocument = z.infer<typeof documentSchema>;

export type RestoreMode = 'merge' | 'replace';
export type RestoreOptions = {
  mode: RestoreMode;
  dryRun?: boolean;
  /** The administrator performing it; a replace refuses to remove this account. */
  actorId?: string | null;
};
export type TableReport = {
  /** Rows in the backup. */
  rows: number;
  /** Merge: rows that already exist and would be overwritten. Replace: rows the target has now (they go away). */
  existing: number;
  action: 'restore' | 'skip';
  note?: string;
};
export type RestoreReport = {
  mode: RestoreMode;
  dryRun: boolean;
  backup: { createdAt: string; migration: string | null };
  tables: Record<string, TableReport>;
  warnings: string[];
};

const parseDocument = (document: unknown): BackupDocument => {
  const parsed = documentSchema.safeParse(document);
  if (!parsed.success) throw new RestoreRefusedError('the backup content is not valid', 'invalid');
  return parsed.data;
};

const plan = (doc: BackupDocument, mode: RestoreMode) => {
  const merging = mode === 'merge';
  // A merge keeps the keys this installation created for itself; the backup's signing keys, and the secrets that hold
  // their private halves, only come back with a replace.
  const keySecretIds = new Set(
    (doc.tables[SIGNING_KEYS_TABLE] ?? []).map((r) => String(r.private_secret_id)),
  );
  return BACKUP_TABLES.map((table: BackupTable) => {
    let rows = doc.tables[table.name] ?? [];
    let note: string | undefined;
    let skip = false;
    if (merging && table.restore === 'replace') {
      skip = true;
      note = 'restored by a replace only';
    } else if (merging && table.name === SECRETS_TABLE) {
      rows = rows.filter((r) => !keySecretIds.has(String(r.id)));
    }
    if (table.name === 'registry_sources') {
      // The cached servers are not in a backup: forget how far the last sync got, so the next one is a full sync.
      rows = rows.map((r) => ({ ...r, last_updated_since: null }));
    }
    if (!(table.name in doc.tables)) note = 'not in this backup';
    return { table, rows, skip, note };
  });
};

const countExisting = async (
  db: Queryable,
  table: string,
  rows: Row[],
  mode: RestoreMode,
): Promise<number> => {
  if (mode === 'replace') {
    const r = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${quote(table)}`,
    );
    return r[0]?.n ?? 0;
  }
  if (rows.length === 0) return 0;
  const pk = await primaryKey(db, table);
  const same = pk.map((c) => `x.${quote(c)} = s.${quote(c)}`).join(' AND ');
  const size = pageRows(table);
  let total = 0;
  for (let i = 0; i < rows.length; i += size) {
    const r = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM jsonb_populate_recordset(NULL::${quote(table)}, $1::jsonb) s
        WHERE EXISTS (SELECT 1 FROM ${quote(table)} x WHERE ${same})`,
      JSON.stringify(rows.slice(i, i + size)),
    );
    total += r[0]?.n ?? 0;
  }
  return total;
};

const insertRows = async (tx: Queryable, table: string, rows: Row[], mode: RestoreMode) => {
  if (rows.length === 0) return;
  const known = new Set(await tableColumns(tx, table));
  // Columns the backup has and this schema still has; anything newer in the schema takes its default.
  const cols = Object.keys(rows[0] as Row).filter((c) => known.has(c));
  const list = cols.map(quote).join(', ');
  let sql = `INSERT INTO ${quote(table)} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${quote(table)}, $1::jsonb)`;
  if (mode === 'merge') {
    await removeClashes(tx, table, rows);
    const pk = await primaryKey(tx, table);
    const update = cols.filter((c) => !pk.includes(c));
    sql += ` ON CONFLICT (${pk.map(quote).join(', ')}) ${
      update.length > 0
        ? `DO UPDATE SET ${update.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')}`
        : 'DO NOTHING'
    }`;
  }
  const size = pageRows(table);
  for (let i = 0; i < rows.length; i += size) {
    try {
      await tx.$executeRawUnsafe(sql, JSON.stringify(rows.slice(i, i + size)));
    } catch (error) {
      throw new RestoreRefusedError(
        `${table}: ${error instanceof Error ? error.message : String(error)}`,
        'conflict',
      );
    }
  }
};

/** Wraps each data key with the KMS of this installation; ids, names and versions (the AAD) stay as they were. */
const sealSecretRows = async (infra: Infra, rows: Row[]): Promise<Row[]> =>
  Promise.all(
    rows.map(async (row) => {
      const { dek, ...rest } = row;
      if (typeof dek !== 'string') {
        throw new RestoreRefusedError(`secret ${String(row.id)} has no data key`, 'invalid');
      }
      const key = Buffer.from(dek, 'base64');
      try {
        return {
          ...rest,
          wrapped_dek: bufferToHex(await infra.kms.wrap(key)),
          kek_ref: infra.kms.kekRef,
        };
      } finally {
        key.fill(0);
      }
    }),
  );

const assertSafeReplace = (doc: BackupDocument, actorId: string | null | undefined): void => {
  const users = doc.tables.users ?? [];
  const admins = users.filter((u) => u.org_role === 'admin' && u.status === 'active');
  if (admins.length === 0) {
    throw new RestoreRefusedError(
      'the backup has no active administrator: restoring it would leave nobody able to sign in',
      'unsafe',
    );
  }
  if (actorId && !admins.some((u) => u.id === actorId)) {
    throw new RestoreRefusedError(
      'the backup does not contain your administrator account: a replace would sign you out for good. ' +
        'Run `bastion restore` on the server instead, or restore into a merge',
      'unsafe',
    );
  }
};

/** Decrypts a backup file and returns the document (also used by the dry run and the console preview). */
export const readBackup = async (
  file: Buffer,
  passphrase: string,
): Promise<{ document: BackupDocument; header: BackupHeader }> => {
  const { document, header } = await openBackup(file, passphrase);
  return { document: parseDocument(document), header };
};

export const restoreBackup = async (
  infra: Infra,
  maintenance: Maintenance,
  document: BackupDocument,
  options: RestoreOptions,
): Promise<RestoreReport> => {
  const { mode } = options;
  const dryRun = options.dryRun === true;
  const target = await lastMigration(infra.db.prisma);
  if (document.migration && (!target || document.migration > target)) {
    throw new RestoreRefusedError(
      `the backup was made at migration ${document.migration}, newer than this installation (${target ?? 'none'}): upgrade Bastion first`,
      'newer_schema',
    );
  }
  if (mode === 'replace') {
    assertSafeReplace(document, options.actorId);
    if (!dryRun && !(await maintenance.get()).enabled) {
      throw new RestoreRefusedError(
        'a replace needs maintenance mode: turn it on first so nothing writes while the data is swapped',
        'maintenance_required',
      );
    }
  }
  const steps = plan(document, mode);
  const warnings: string[] = [];
  const tables: Record<string, TableReport> = {};
  for (const step of steps) {
    tables[step.table.name] = {
      rows: step.skip ? 0 : step.rows.length,
      existing: await countExisting(
        infra.db.prisma,
        step.table.name,
        step.skip ? [] : step.rows,
        mode,
      ),
      action: step.skip ? 'skip' : 'restore',
      ...(step.note ? { note: step.note } : {}),
    };
    if (step.note === 'not in this backup')
      warnings.push(`${step.table.name} is not in this backup`);
    if (mode === 'merge' && !step.skip) {
      for (const clash of await findClashes(infra.db.prisma, step.table.name, step.rows)) {
        if (step.table.name === 'users' && options.actorId && clash.ids.includes(options.actorId)) {
          throw new RestoreRefusedError(
            `the backup has a different account with the same ${clash.key} as yours: merging would replace your account and sign you out. ` +
              'Run `bastion restore` on the server instead',
            'unsafe',
          );
        }
        warnings.push(
          `${step.table.name}: ${clash.count} existing row${clash.count === 1 ? ' shares' : 's share'} ${clash.key} with a row of the backup and ${clash.count === 1 ? 'is' : 'are'} replaced by it (the backup wins)`,
        );
      }
    }
  }
  const report: RestoreReport = {
    mode,
    dryRun,
    backup: { createdAt: document.createdAt, migration: document.migration },
    tables,
    warnings,
  };
  if (dryRun) return report;

  const prepared = steps.map((s) => ({ ...s }));
  const secrets = prepared.find((s) => s.table.name === SECRETS_TABLE);
  if (secrets) secrets.rows = await sealSecretRows(infra, secrets.rows);

  const events: { scope: string; id: string; version: bigint }[] = [];
  await infra.db.prisma.$transaction(async (tx) => {
    if (mode === 'replace') {
      for (const step of [...prepared].reverse()) {
        await tx.$executeRawUnsafe(`DELETE FROM ${quote(step.table.name)}`);
      }
    }
    for (const step of prepared) {
      if (!step.skip) await insertRows(tx, step.table.name, step.rows, mode);
    }
    if (mode === 'replace') {
      // Rows came back with their original `seq`; the sequence must continue after them.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('${AUDIT_TABLE}', 'seq'),
                GREATEST((SELECT COALESCE(MAX(seq), 1) FROM ${AUDIT_TABLE}), 1),
                (SELECT MAX(seq) IS NOT NULL FROM ${AUDIT_TABLE}))`,
      );
    }
    events.push({ scope: 'org', id: NIL_UUID, version: await bumpConfigVersion(tx, 'org') });
    for (const entry of document.tables.catalog_entries ?? []) {
      const id = String(entry.id);
      events.push({ scope: 'catalog', id, version: await bumpConfigVersion(tx, 'catalog', id) });
    }
    // Chains from the restored tail on a replace, from this instance's own log on a merge.
    await appendAuditEvent(tx, {
      actorType: options.actorId ? 'user' : 'system',
      actorId: options.actorId ?? null,
      action: `backup.restore.${mode}`,
      targetType: 'backup',
      targetId: newId(),
      diff: {
        backupCreatedAt: document.createdAt,
        counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.rows])),
      },
    });
  }, BACKUP_TX_OPTIONS);

  for (const event of events) {
    await infra.publish('bastion:config', {
      topic: event.scope,
      scope: event.scope,
      id: event.id,
      version: String(event.version),
    });
  }
  if (mode === 'replace') {
    // The authorization server and workers reload the restored signing and state keys.
    for (const topic of ['signing_keys', 'state_keys']) {
      await infra.publish('bastion:config', { topic, scope: topic, id: NIL_UUID });
    }
  }
  return report;
};
