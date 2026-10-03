/**
 * `bastion export-config` / `import-config` (20.1): the declarative part of an installation as JSON, for backup,
 * promotion between environments and GitOps. Secrets are NEVER exported: no secret values, secret ids, tokens,
 * ciphertext, client secrets or key material appear (the columns that reference them are not selected, and the one JSON
 * column that may embed a secret id, `marketplaces.mirror`, is scrubbed). Users, teams, installations and tokens are not
 * part of it. Import is an idempotent upsert by id inside one transaction with an audit event.
 */
import { appendAuditEvent, bumpConfigVersion, NIL_UUID, Prisma } from '@bastion-mcp/db';
import { z } from 'zod';
import type { Infra } from '../infra';
import { CONFIG_IMPORT_TX_OPTIONS } from '../timing';

export const CONFIG_FORMAT = 1;

type Kind = 'date' | 'json' | 'jsonNullable' | 'plain';
type ModelSpec = {
  /** Key in the export document. */
  key: string;
  /** Prisma delegate name. */
  delegate: string;
  /** Primary key columns used to upsert. */
  id: readonly string[];
  fields: Record<string, Kind>;
  /** Columns holding a team id that may not exist in the target. */
  teamRefs?: readonly string[];
};

/** Import order: parents before children. */
const MODELS: readonly ModelSpec[] = [
  {
    key: 'settings',
    delegate: 'orgSetting',
    id: ['key'],
    fields: { key: 'plain', value: 'json', updatedAt: 'date' },
  },
  {
    key: 'guardProfiles',
    delegate: 'guardProfile',
    id: ['id'],
    fields: {
      id: 'plain',
      name: 'plain',
      isOrgDefault: 'plain',
      latencyBudgetMs: 'plain',
      guards: 'json',
      settings: 'json',
      createdAt: 'date',
    },
  },
  {
    key: 'limitRules',
    delegate: 'limitRule',
    id: ['id'],
    teamRefs: ['ownerTeamId'],
    fields: {
      id: 'plain',
      name: 'plain',
      ownerTeamId: 'plain',
      subject: 'plain',
      subjectMatch: 'json',
      scope: 'json',
      kind: 'plain',
      params: 'json',
      metric: 'plain',
      cost: 'jsonNullable',
      action: 'plain',
      enabled: 'plain',
      createdAt: 'date',
    },
  },
  {
    key: 'policyRules',
    delegate: 'policyRule',
    id: ['id'],
    teamRefs: ['ownerTeamId'],
    fields: {
      id: 'plain',
      name: 'plain',
      ownerTeamId: 'plain',
      effect: 'plain',
      who: 'json',
      what: 'json',
      when: 'json',
      enabled: 'plain',
      priority: 'plain',
      createdBy: 'plain',
      createdAt: 'date',
    },
  },
  {
    key: 'customPolicies',
    delegate: 'customPolicy',
    id: ['id'],
    fields: {
      id: 'plain',
      name: 'plain',
      cedar: 'plain',
      tests: 'json',
      enabled: 'plain',
      createdBy: 'plain',
      createdAt: 'date',
    },
  },
  {
    key: 'registrySources',
    delegate: 'registrySource',
    id: ['id'],
    fields: {
      id: 'plain',
      name: 'plain',
      baseUrl: 'plain',
      authHeaderName: 'plain',
      trust: 'plain',
      enabled: 'plain',
      syncIntervalS: 'plain',
      createdAt: 'date',
    },
  },
  {
    key: 'catalogEntries',
    delegate: 'catalogEntry',
    id: ['id'],
    teamRefs: ['ownerTeamId'],
    fields: {
      id: 'plain',
      slug: 'plain',
      kind: 'plain',
      displayName: 'plain',
      description: 'plain',
      tags: 'plain',
      ownerTeamId: 'plain',
      visibility: 'json',
      status: 'plain',
      risk: 'plain',
      source: 'json',
      currentVersionId: 'plain',
      autoUpgrade: 'plain',
      userOverrides: 'plain',
      onDrift: 'plain',
      createdBy: 'plain',
      createdAt: 'date',
    },
  },
  {
    key: 'catalogVersions',
    delegate: 'catalogVersion',
    id: ['id'],
    fields: {
      id: 'plain',
      entryId: 'plain',
      label: 'plain',
      serverSpec: 'json',
      overrides: 'json',
      guardProfileId: 'plain',
      limits: 'json',
      installForm: 'json',
      lockfile: 'jsonNullable',
      protocolEra: 'plain',
      testResult: 'jsonNullable',
      runtime: 'json',
      status: 'plain',
      changelog: 'plain',
      createdBy: 'plain',
      createdAt: 'date',
      publishedAt: 'date',
    },
  },
  {
    key: 'marketplaces',
    delegate: 'marketplace',
    id: ['id'],
    teamRefs: ['ownerTeamId'],
    fields: {
      id: 'plain',
      slug: 'plain',
      displayName: 'plain',
      description: 'plain',
      ownerTeamId: 'plain',
      audience: 'json',
      desktopInstallation: 'plain',
      mirror: 'jsonNullable',
      createdBy: 'plain',
      createdAt: 'date',
    },
  },
  {
    key: 'marketplaceItems',
    delegate: 'marketplaceItem',
    id: ['marketplaceId', 'catalogEntryId'],
    fields: {
      marketplaceId: 'plain',
      catalogEntryId: 'plain',
      policy: 'plain',
      pinnedVersionId: 'plain',
      position: 'plain',
    },
  },
];

const SECRETISH = /secret|token|password|ciphertext|credential|private/i;

/** Removes any key that names a secret, at any depth (defense in depth for JSON columns). */
export const scrubSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !SECRETISH.test(k))
        .map(([k, v]) => [k, scrubSecrets(v)]),
    );
  }
  return value;
};

export type ConfigDocument = {
  format: typeof CONFIG_FORMAT;
  exportedAt: string;
} & Record<string, unknown>;

type Delegate = {
  findMany(args: unknown): Promise<Record<string, unknown>[]>;
  upsert(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<unknown>;
  createMany(args: unknown): Promise<unknown>;
};

const delegateOf = (client: unknown, name: string): Delegate =>
  (client as Record<string, Delegate>)[name] as Delegate;

const toExport = (spec: ModelSpec, row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(spec.fields)) {
    const value = row[field];
    if (value === undefined) continue;
    if (kind === 'date') out[field] = value instanceof Date ? value.toISOString() : value;
    else out[field] = value;
  }
  // The mirror target names a credential secret; the reference must not leave the instance.
  if (spec.key === 'marketplaces' && out.mirror) out.mirror = scrubSecrets(out.mirror);
  return out;
};

export const exportConfig = async (infra: Infra, now = new Date()): Promise<ConfigDocument> => {
  const prisma = infra.db.prisma;
  const doc: ConfigDocument = { format: CONFIG_FORMAT, exportedAt: now.toISOString() };
  for (const spec of MODELS) {
    const rows = await delegateOf(prisma, spec.delegate).findMany({
      orderBy: spec.id.map((f) => ({ [f]: 'asc' })),
    });
    doc[spec.key] = rows.map((r) => toExport(spec, r));
  }
  return doc;
};

const docSchema = z.looseObject({ format: z.literal(CONFIG_FORMAT) });

export class ConfigImportError extends Error {}

const fromImport = (spec: ModelSpec, raw: unknown, teams: Set<string>): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null)
    throw new ConfigImportError(`${spec.key}: rows must be objects`);
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(spec.fields)) {
    if (!(field in row)) continue;
    const value = row[field];
    if (kind === 'date') out[field] = typeof value === 'string' ? new Date(value) : value;
    else if (kind === 'jsonNullable') out[field] = value === null ? Prisma.DbNull : value;
    else out[field] = value;
  }
  for (const ref of spec.teamRefs ?? []) {
    const id = out[ref];
    if (typeof id === 'string' && !teams.has(id)) out[ref] = null;
  }
  for (const idField of spec.id) {
    if (out[idField] === undefined)
      throw new ConfigImportError(`${spec.key}: row without ${idField}`);
  }
  return out;
};

export type ImportReport = { counts: Record<string, number>; dryRun: boolean };

/** Idempotent upsert by id in one transaction; audit event and `bastion:config` bumps included (4.3, 17.1). */
export const importConfig = async (
  infra: Infra,
  input: unknown,
  options: { dryRun?: boolean } = {},
): Promise<ImportReport> => {
  const parsed = docSchema.safeParse(input);
  if (!parsed.success)
    throw new ConfigImportError('not a Bastion config export (format 1 expected)');
  const doc = parsed.data as Record<string, unknown>;
  const teams = new Set(
    (await infra.db.prisma.team.findMany({ select: { id: true } })).map((t) => t.id),
  );
  const counts: Record<string, number> = {};
  const plans = MODELS.map((spec) => {
    const rows = doc[spec.key];
    if (rows === undefined) return { spec, rows: [] as Record<string, unknown>[] };
    if (!Array.isArray(rows)) throw new ConfigImportError(`${spec.key} must be an array`);
    return { spec, rows: rows.map((r) => fromImport(spec, r, teams)) };
  });
  for (const { spec, rows } of plans) counts[spec.key] = rows.length;
  if (options.dryRun) return { counts, dryRun: true };

  const events: { scope: string; id: string; version: bigint }[] = [];
  await infra.db.prisma.$transaction(async (tx) => {
    for (const { spec, rows } of plans) {
      const delegate = delegateOf(tx, spec.delegate);
      if (spec.key === 'marketplaceItems') {
        const marketplaces = [...new Set(rows.map((r) => r.marketplaceId as string))];
        if (marketplaces.length > 0) {
          await delegate.deleteMany({ where: { marketplaceId: { in: marketplaces } } });
          await delegate.createMany({ data: rows });
        }
        continue;
      }
      for (const row of rows) {
        const where =
          spec.id.length === 1
            ? { [spec.id[0] as string]: row[spec.id[0] as string] }
            : { [spec.id.join('_')]: Object.fromEntries(spec.id.map((f) => [f, row[f]])) };
        await delegate.upsert({ where, create: row, update: row });
      }
    }
    events.push({
      scope: 'org',
      id: NIL_UUID,
      version: await bumpConfigVersion(tx, 'org'),
    });
    for (const row of plans.find((p) => p.spec.key === 'catalogEntries')?.rows ?? []) {
      const id = row.id as string;
      events.push({ scope: 'catalog', id, version: await bumpConfigVersion(tx, 'catalog', id) });
    }
    await appendAuditEvent(tx, {
      actorType: 'system',
      action: 'config.import',
      targetType: 'config',
      diff: { counts },
    });
  }, CONFIG_IMPORT_TX_OPTIONS);
  for (const event of events) {
    await infra.publish('bastion:config', {
      topic: event.scope,
      scope: event.scope,
      id: event.id,
      version: String(event.version),
    });
  }
  return { counts, dryRun: false };
};
