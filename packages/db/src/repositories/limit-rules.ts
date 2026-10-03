import { LIMIT_KINDS, newId } from '@bastion-mcp/core';
import { z } from 'zod';
import type { LimitRule } from '../generated/client';
import {
  type AuditContext,
  assertIfMatch,
  assertSwapped,
  etagOf,
  mutate,
  NotFoundError,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  toJsonOrNull,
  versionedUpdate,
  versionGuard,
} from './support';

// --- limit_rules (14.1) -----------------------------------------------------------------------------------------------------------

export const LIMIT_SUBJECTS = ['user', 'team', 'role', 'serviceAccount', 'org', 'client'] as const;
export const LIMIT_METRICS = ['calls', 'bytesOut', 'samplingRequests', 'modelGuardTokens'] as const;
export const LIMIT_ACTIONS = ['reject', 'warn'] as const;

const subjectMatchSchema = z.union([z.literal('each'), z.array(z.string().min(1)).min(1)]);
const scopeSchema = z.object({
  installationId: z.string().min(1).optional(),
  catalogEntryId: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});
const rateParams = z.object({
  points: z.number().int().positive(),
  perSeconds: z.number().int().positive(),
  burst: z.number().int().nonnegative(),
});
const quotaParams = z.object({
  points: z.number().int().positive(),
  period: z.enum(['day', 'week', 'month']),
});
const concurrencyParams = z.object({
  max: z.number().int().positive(),
  leaseSeconds: z.number().int().positive().default(900),
});
const paramsByKind = {
  rate: rateParams,
  quota: quotaParams,
  concurrency: concurrencyParams,
} as const;

export type LimitRuleView = {
  id: string;
  name: string;
  ownerTeamId: string | null;
  subject: (typeof LIMIT_SUBJECTS)[number];
  subjectMatch: 'each' | string[];
  scope: z.infer<typeof scopeSchema>;
  kind: (typeof LIMIT_KINDS)[number];
  params: Record<string, unknown>;
  metric: (typeof LIMIT_METRICS)[number];
  cost: Record<string, number> | null;
  action: (typeof LIMIT_ACTIONS)[number];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date | null;
};

const toLimitRule = (r: LimitRule): LimitRuleView => {
  const kind = z.enum(LIMIT_KINDS).parse(r.kind);
  return {
    id: r.id,
    name: r.name,
    ownerTeamId: r.ownerTeamId,
    subject: z.enum(LIMIT_SUBJECTS).parse(r.subject),
    subjectMatch: subjectMatchSchema.parse(r.subjectMatch),
    scope: scopeSchema.parse(r.scope),
    kind,
    params: paramsByKind[kind].parse(r.params),
    metric: z.enum(LIMIT_METRICS).parse(r.metric),
    cost: r.cost === null ? null : z.record(z.string(), z.number().int().positive()).parse(r.cost),
    action: z.enum(LIMIT_ACTIONS).parse(r.action),
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
};

export type LimitRuleInput = {
  id?: string;
  name: string;
  ownerTeamId?: string | null;
  subject: LimitRuleView['subject'];
  subjectMatch?: LimitRuleView['subjectMatch'];
  scope?: LimitRuleView['scope'];
  kind: LimitRuleView['kind'];
  params: Record<string, unknown>;
  metric?: LimitRuleView['metric'];
  cost?: Record<string, number> | null;
  action?: LimitRuleView['action'];
  enabled?: boolean;
};

/** `limit_rules` CRUD; params are validated per kind exactly as the limits engine will read them. */
export const createLimitRuleRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  const parts = (input: Partial<LimitRuleInput> & { kind: LimitRuleView['kind'] }) => ({
    params: paramsByKind[input.kind].parse(input.params),
    subjectMatch: subjectMatchSchema.parse(input.subjectMatch ?? 'each'),
    scope: scopeSchema.parse(input.scope ?? {}),
  });
  return {
    async get(id: string): Promise<LimitRuleView | null> {
      const row = await db.limitRule.findUnique({ where: { id } });
      return row ? toLimitRule(row) : null;
    },
    async getWithEtag(id: string): Promise<{ rule: LimitRuleView; etag: string } | null> {
      const row = await db.limitRule.findUnique({ where: { id } });
      return row ? { rule: toLimitRule(row), etag: etagOf(row) } : null;
    },
    async list(filter: { ownerTeamId?: string; enabled?: boolean } = {}): Promise<LimitRuleView[]> {
      const rows = await db.limitRule.findMany({
        where: {
          ...(filter.ownerTeamId ? { ownerTeamId: filter.ownerTeamId } : {}),
          ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
        },
        orderBy: { id: 'asc' },
      });
      return rows.map(toLimitRule);
    },
    async create(input: LimitRuleInput, audit?: AuditContext): Promise<LimitRuleView> {
      const p = parts(input);
      return mutate(ctx, async (tx, unit) => {
        const row = await tx.limitRule.create({
          data: {
            id: input.id ?? newId(),
            name: input.name,
            ownerTeamId: input.ownerTeamId ?? null,
            subject: input.subject,
            subjectMatch: toJson(p.subjectMatch),
            scope: toJson(p.scope),
            kind: input.kind,
            params: toJson(p.params),
            metric: input.metric ?? 'calls',
            cost: toJsonOrNull(input.cost),
            action: input.action ?? 'reject',
            enabled: input.enabled ?? true,
          },
        });
        unit.bump('org');
        unit.audit(audit, {
          action: 'limit_rule.create',
          targetType: 'limit_rule',
          targetId: row.id,
          diff: { before: null, after: toLimitRule(row) },
        });
        return toLimitRule(row);
      });
    },
    async update(
      id: string,
      patch: Partial<Omit<LimitRuleInput, 'id' | 'kind'>>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<LimitRuleView> {
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'limit rule',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.limitRule.findUnique({ where: { id } }),
          write: async (current, where, updatedAt) => {
            const kind = z.enum(LIMIT_KINDS).parse(current.kind);
            const { params, subjectMatch, scope, cost, ...rest } = patch;
            return tx.limitRule.updateMany({
              where,
              data: {
                ...rest,
                ...(params === undefined
                  ? {}
                  : { params: toJson(paramsByKind[kind].parse(params)) }),
                ...(subjectMatch === undefined
                  ? {}
                  : { subjectMatch: toJson(subjectMatchSchema.parse(subjectMatch)) }),
                ...(scope === undefined ? {} : { scope: toJson(scopeSchema.parse(scope)) }),
                ...(cost === undefined ? {} : { cost: toJsonOrNull(cost) }),
                updatedAt,
              },
            });
          },
          reload: () => tx.limitRule.findUniqueOrThrow({ where: { id } }),
        });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'limit_rule.update',
          targetType: 'limit_rule',
          targetId: id,
          diff: { before: toLimitRule(current), after: toLimitRule(row) },
        });
        return toLimitRule(row);
      });
    },
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.limitRule.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('limit rule', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(await tx.limitRule.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'limit_rule.delete',
          targetType: 'limit_rule',
          targetId: id,
          diff: { before: toLimitRule(current), after: null },
        });
      });
    },
  };
};
