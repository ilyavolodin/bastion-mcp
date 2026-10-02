import {
  DRIFT_POLICIES,
  ITEM_KINDS,
  LIMIT_KINDS,
  newId,
  POLICY_EFFECTS,
  REVIEW_STATUSES,
  RISK_LEVELS,
} from '@bastion-mcp/core';
import { z } from 'zod';
import type { DefinitionPin, DriftReview, GuardProfile, LimitRule, PolicyRule } from '../generated/client';
import { visibilitySchema } from './catalog';
import { createOrgSettingsRepository } from './org';
import {
  type AuditContext,
  afterIdDesc,
  assertIfMatch,
  assertSwapped,
  bytesToHex,
  ConflictError,
  clampLimit,
  etagOf,
  hexToBytes,
  idCursorOf,
  jsonObjectSchema,
  mutate,
  NotFoundError,
  nextUpdatedAt,
  orConflict,
  type Paged,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  toJsonOrNull,
  toPage,
  versionGuard,
} from './support';

// --- policy_rules (10.3) ---------------------------------------------------------------------------------------------------

const effectSchema = z.enum(POLICY_EFFECTS);
const objectSchema = z.record(z.string(), z.unknown());

export type PolicyRuleView = {
  id: string;
  name: string;
  ownerTeamId: string | null;
  effect: (typeof POLICY_EFFECTS)[number];
  who: Record<string, unknown>;
  what: Record<string, unknown>;
  when: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

const toPolicyRule = (r: PolicyRule): PolicyRuleView => ({
  id: r.id,
  name: r.name,
  ownerTeamId: r.ownerTeamId,
  effect: effectSchema.parse(r.effect),
  who: objectSchema.parse(r.who),
  what: objectSchema.parse(r.what),
  when: objectSchema.parse(r.when),
  enabled: r.enabled,
  priority: r.priority,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export type PolicyRuleInput = {
  id?: string;
  name: string;
  ownerTeamId?: string | null;
  effect: (typeof POLICY_EFFECTS)[number];
  who: Record<string, unknown>;
  what: Record<string, unknown>;
  when?: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
  createdBy: string;
};

/** `policy_rules` (tool rules of 10.3). Any change bumps the `org` configuration version. */
export const createPolicyRuleRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<PolicyRuleView | null> {
      const row = await db.policyRule.findUnique({ where: { id } });
      return row ? toPolicyRule(row) : null;
    },
    async getWithEtag(id: string): Promise<{ rule: PolicyRuleView; etag: string } | null> {
      const row = await db.policyRule.findUnique({ where: { id } });
      return row ? { rule: toPolicyRule(row), etag: etagOf(row) } : null;
    },
    async list(
      filter: { ownerTeamId?: string; enabled?: boolean; limit?: number; cursor?: string } = {},
    ): Promise<Paged<PolicyRuleView>> {
      const limit = clampLimit(filter.limit);
      const rows = await db.policyRule.findMany({
        where: {
          ...(filter.ownerTeamId ? { ownerTeamId: filter.ownerTeamId } : {}),
          ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
          ...afterIdDesc(filter.cursor),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const page = toPage(rows, limit, idCursorOf);
      return { items: page.items.map(toPolicyRule), nextCursor: page.nextCursor };
    },
    async create(input: PolicyRuleInput, audit?: AuditContext): Promise<PolicyRuleView> {
      const who = objectSchema.parse(input.who);
      const what = objectSchema.parse(input.what);
      const when = objectSchema.parse(input.when ?? {});
      return mutate(ctx, async (tx, unit) => {
        const row = await tx.policyRule.create({
          data: {
            id: input.id ?? newId(),
            name: input.name,
            ownerTeamId: input.ownerTeamId ?? null,
            effect: input.effect,
            who: toJson(who),
            what: toJson(what),
            when: toJson(when),
            enabled: input.enabled ?? true,
            priority: input.priority ?? 100,
            createdBy: input.createdBy,
          },
        });
        unit.bump('org');
        unit.audit(audit, {
          action: 'policy_rule.create',
          targetType: 'policy_rule',
          targetId: row.id,
          diff: { before: null, after: toPolicyRule(row) },
        });
        return toPolicyRule(row);
      });
    },
    async update(
      id: string,
      patch: Partial<Omit<PolicyRuleInput, 'id' | 'createdBy'>>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<PolicyRuleView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.policyRule.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('policy rule', id);
        assertIfMatch(current, opts.ifMatch);
        const { who, what, when, ...rest } = patch;
        assertSwapped(
          await tx.policyRule.updateMany({
            where: { id, ...versionGuard(current) },
            data: {
              ...rest,
              ...(who === undefined ? {} : { who: toJson(objectSchema.parse(who)) }),
              ...(what === undefined ? {} : { what: toJson(objectSchema.parse(what)) }),
              ...(when === undefined ? {} : { when: toJson(objectSchema.parse(when)) }),
              updatedAt: nextUpdatedAt(current),
            },
          }),
        );
        const row = await tx.policyRule.findUniqueOrThrow({ where: { id } });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'policy_rule.update',
          targetType: 'policy_rule',
          targetId: id,
          diff: { before: toPolicyRule(current), after: toPolicyRule(row) },
        });
        return toPolicyRule(row);
      });
    },
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.policyRule.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('policy rule', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(await tx.policyRule.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'policy_rule.delete',
          targetType: 'policy_rule',
          targetId: id,
          diff: { before: toPolicyRule(current), after: null },
        });
      });
    },
  };
};

// --- custom_policies (10.4) -------------------------------------------------------------------------------------------------

export type CustomPolicyView = {
  id: string;
  name: string;
  cedar: string;
  tests: unknown[];
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

const toCustomPolicy = (r: {
  id: string;
  name: string;
  cedar: string;
  tests: unknown;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
}): CustomPolicyView => ({ ...r, tests: z.array(z.unknown()).parse(r.tests) });

/** `custom_policies`: Cedar source plus its saved test cases. */
export const createCustomPolicyRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<CustomPolicyView | null> {
      const row = await db.customPolicy.findUnique({ where: { id } });
      return row ? toCustomPolicy(row) : null;
    },
    async getWithEtag(id: string): Promise<{ policy: CustomPolicyView; etag: string } | null> {
      const row = await db.customPolicy.findUnique({ where: { id } });
      return row ? { policy: toCustomPolicy(row), etag: etagOf(row) } : null;
    },
    async list(): Promise<CustomPolicyView[]> {
      return (await db.customPolicy.findMany({ orderBy: { name: 'asc' } })).map(toCustomPolicy);
    },
    async create(
      input: { id?: string; name: string; cedar: string; tests?: unknown[]; enabled?: boolean; createdBy: string },
      audit?: AuditContext,
    ): Promise<CustomPolicyView> {
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('custom policy', () =>
          tx.customPolicy.create({
            data: {
              id: input.id ?? newId(),
              name: input.name,
              cedar: input.cedar,
              tests: toJson(input.tests ?? []),
              enabled: input.enabled ?? true,
              createdBy: input.createdBy,
            },
          }),
        );
        unit.bump('org');
        unit.audit(audit, {
          action: 'custom_policy.create',
          targetType: 'custom_policy',
          targetId: row.id,
          diff: { before: null, after: { name: row.name, enabled: row.enabled } },
        });
        return toCustomPolicy(row);
      });
    },
    async update(
      id: string,
      patch: { name?: string; cedar?: string; tests?: unknown[]; enabled?: boolean },
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<CustomPolicyView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.customPolicy.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('custom policy', id);
        assertIfMatch(current, opts.ifMatch);
        const { tests, ...rest } = patch;
        assertSwapped(
          await orConflict('custom policy', () =>
            tx.customPolicy.updateMany({
              where: { id, ...versionGuard(current) },
              data: {
                ...rest,
                ...(tests === undefined ? {} : { tests: toJson(tests) }),
                updatedAt: nextUpdatedAt(current),
              },
            }),
          ),
        );
        const row = await tx.customPolicy.findUniqueOrThrow({ where: { id } });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'custom_policy.update',
          targetType: 'custom_policy',
          targetId: id,
          diff: {
            before: { name: current.name, enabled: current.enabled, cedar: current.cedar },
            after: { name: row.name, enabled: row.enabled, cedar: row.cedar },
          },
        });
        return toCustomPolicy(row);
      });
    },
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.customPolicy.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('custom policy', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(await tx.customPolicy.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'custom_policy.delete',
          targetType: 'custom_policy',
          targetId: id,
          diff: { before: { name: current.name }, after: null },
        });
      });
    },
  };
};

// --- PolicyDataSource (10.3) ---------------------------------------------------------------------------------------------------

/** `PolicyDataInput` of `@bastion-mcp/policy`, assembled field by field (see `policyDataSchema`). */
export type PolicyDataRow = {
  orgId?: string;
  settings: { logsManagerVisibility: boolean };
  orgWidePublisherIds: string[];
  teams: { id: string; slug: string }[];
  catalogEntries: {
    id: string;
    ownerTeamId?: string;
    visibility: { org: boolean; teamIds: string[]; userIds: string[] };
    risk: (typeof RISK_LEVELS)[number];
  }[];
  installations: {
    id: string;
    catalogEntryId: string;
    ownerUserId?: string;
    ownerTeamId?: string;
    ownerServiceId?: string;
    ownerServiceTeamId?: string;
    catalogEntry?: {
      ownerTeamId?: string;
      visibility: { org: boolean; teamIds: string[]; userIds: string[] };
      risk: (typeof RISK_LEVELS)[number];
    };
  }[];
  rules: {
    id: string;
    effect: (typeof POLICY_EFFECTS)[number];
    who: Record<string, unknown>;
    what: Record<string, unknown>;
    when: Record<string, unknown>;
  }[];
  customPolicies: { id: string; cedar: string }[];
};

const riskSchema = z.enum(RISK_LEVELS);

/**
 * `PolicyDataSource.load`: teams, catalog entries, installations (a personal installation uses its own id as
 * `catalogEntryId`), enabled tool rules in priority order and enabled custom policies. Team-owned rules keep their
 * scope in `who`; `ownerTeamId` is not part of the policy payload.
 */
export const createPolicyDataSource = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  const settings = createOrgSettingsRepository(arg, options);
  return {
    async load(signal?: AbortSignal): Promise<PolicyDataRow> {
      signal?.throwIfAborted();
      const [orgSettings, publishers, teams, entries, installations, accounts, rules, custom] = await Promise.all([
        settings.get('logs'),
        db.user.findMany({
          where: { catalogPublishOrgWide: true, status: 'active' },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
        db.team.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } }),
        db.catalogEntry.findMany({
          select: { id: true, ownerTeamId: true, visibility: true, risk: true },
          orderBy: { id: 'asc' },
        }),
        db.installation.findMany({
          select: { id: true, ownerType: true, ownerId: true, catalogEntryId: true },
          orderBy: { id: 'asc' },
        }),
        db.serviceAccount.findMany({ select: { id: true, teamId: true } }),
        db.policyRule.findMany({ where: { enabled: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] }),
        db.customPolicy.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } }),
      ]);
      signal?.throwIfAborted();
      const entryAttrs = new Map(
        entries.map((e) => [
          e.id,
          {
            ...(e.ownerTeamId ? { ownerTeamId: e.ownerTeamId } : {}),
            visibility: visibilitySchema.parse(e.visibility),
            risk: riskSchema.parse(e.risk),
          },
        ]),
      );
      const serviceTeam = new Map(accounts.map((a) => [a.id, a.teamId]));
      return {
        settings: { logsManagerVisibility: orgSettings.managerVisibility },
        orgWidePublisherIds: publishers.map((p) => p.id),
        teams,
        catalogEntries: entries.map((e) => ({ id: e.id, ...(entryAttrs.get(e.id) as NonNullable<ReturnType<typeof entryAttrs.get>>) })),
        installations: installations.map((i) => {
          const entryId = i.catalogEntryId ?? i.id;
          const attrs = i.catalogEntryId ? entryAttrs.get(i.catalogEntryId) : undefined;
          return {
            id: i.id,
            catalogEntryId: entryId,
            ...(i.ownerType === 'user' ? { ownerUserId: i.ownerId } : {}),
            ...(i.ownerType === 'team' ? { ownerTeamId: i.ownerId } : {}),
            ...(i.ownerType === 'service'
              ? {
                  ownerServiceId: i.ownerId,
                  ...(serviceTeam.has(i.ownerId) ? { ownerServiceTeamId: serviceTeam.get(i.ownerId) as string } : {}),
                }
              : {}),
            ...(attrs ? { catalogEntry: attrs } : {}),
          };
        }),
        rules: rules.map((r) => ({
          id: r.id,
          effect: effectSchema.parse(r.effect),
          who: objectSchema.parse(r.who),
          what: objectSchema.parse(r.what),
          when: objectSchema.parse(r.when),
        })),
        customPolicies: custom.map((c) => ({ id: c.id, cedar: c.cedar })),
      };
    },
  };
};

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
const paramsByKind = { rate: rateParams, quota: quotaParams, concurrency: concurrencyParams } as const;

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
        const current = await tx.limitRule.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('limit rule', id);
        assertIfMatch(current, opts.ifMatch);
        const kind = z.enum(LIMIT_KINDS).parse(current.kind);
        const { params, subjectMatch, scope, cost, ...rest } = patch;
        assertSwapped(
          await tx.limitRule.updateMany({
            where: { id, ...versionGuard(current) },
            data: {
              ...rest,
              ...(params === undefined ? {} : { params: toJson(paramsByKind[kind].parse(params)) }),
              ...(subjectMatch === undefined ? {} : { subjectMatch: toJson(subjectMatchSchema.parse(subjectMatch)) }),
              ...(scope === undefined ? {} : { scope: toJson(scopeSchema.parse(scope)) }),
              ...(cost === undefined ? {} : { cost: toJsonOrNull(cost) }),
              updatedAt: nextUpdatedAt(current),
            },
          }),
        );
        const row = await tx.limitRule.findUniqueOrThrow({ where: { id } });
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

// --- guard_profiles (13.1) --------------------------------------------------------------------------------------------------------

const guardInstancesSchema = z.array(
  z.looseObject({ instanceId: z.string().min(1), type: z.string().min(1) }),
);
const guardSettingsSchema = z.looseObject({
  maxScanBytes: z.number().int().min(1).optional(),
  onOversize: z.enum(['scanPrefix', 'block']).optional(),
  onDrift: z.enum(DRIFT_POLICIES).optional(),
  riskEscalation: z.looseObject({}).optional(),
});

export type GuardProfileView = {
  id: string;
  name: string;
  isOrgDefault: boolean;
  latencyBudgetMs: number;
  guards: z.infer<typeof guardInstancesSchema>;
  settings: z.infer<typeof guardSettingsSchema>;
  createdAt: Date;
  updatedAt: Date | null;
};

const toProfile = (r: GuardProfile): GuardProfileView => ({
  id: r.id,
  name: r.name,
  isOrgDefault: r.isOrgDefault,
  latencyBudgetMs: r.latencyBudgetMs,
  guards: guardInstancesSchema.parse(r.guards),
  settings: guardSettingsSchema.parse(r.settings),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** The object `guardProfileSchema.parse` of `@bastion-mcp/guards` accepts for a stored profile. */
export const toPipelineProfile = (p: GuardProfileView): Record<string, unknown> => ({
  profileId: p.id,
  guards: p.guards,
  latencyBudgetMs: p.latencyBudgetMs,
  ...p.settings,
});

export type GuardProfileInput = {
  id?: string;
  name: string;
  latencyBudgetMs?: number;
  guards: unknown[];
  settings?: Record<string, unknown>;
};

/** `guard_profiles` CRUD with a single org default, mirrored into `settings.guards.orgDefaultProfileId`. */
export const createGuardProfileRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<GuardProfileView | null> {
      const row = await db.guardProfile.findUnique({ where: { id } });
      return row ? toProfile(row) : null;
    },
    async getWithEtag(id: string): Promise<{ profile: GuardProfileView; etag: string } | null> {
      const row = await db.guardProfile.findUnique({ where: { id } });
      return row ? { profile: toProfile(row), etag: etagOf(row) } : null;
    },
    async getOrgDefault(): Promise<GuardProfileView | null> {
      const row = await db.guardProfile.findFirst({ where: { isOrgDefault: true } });
      return row ? toProfile(row) : null;
    },
    async list(): Promise<GuardProfileView[]> {
      return (await db.guardProfile.findMany({ orderBy: { name: 'asc' } })).map(toProfile);
    },
    async create(input: GuardProfileInput, audit?: AuditContext): Promise<GuardProfileView> {
      const guards = guardInstancesSchema.parse(input.guards);
      const settings = guardSettingsSchema.parse(input.settings ?? {});
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('guard profile', () =>
          tx.guardProfile.create({
            data: {
              id: input.id ?? newId(),
              name: input.name,
              latencyBudgetMs: input.latencyBudgetMs ?? 1500,
              guards: toJson(guards),
              settings: toJson(settings),
            },
          }),
        );
        unit.bump('org');
        unit.audit(audit, {
          action: 'guard_profile.create',
          targetType: 'guard_profile',
          targetId: row.id,
          diff: { before: null, after: { name: row.name, guards: guards.length } },
        });
        return toProfile(row);
      });
    },
    async update(
      id: string,
      patch: Partial<Omit<GuardProfileInput, 'id'>>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<GuardProfileView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.guardProfile.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('guard profile', id);
        assertIfMatch(current, opts.ifMatch);
        const { guards, settings, ...rest } = patch;
        assertSwapped(
          await orConflict('guard profile', () =>
            tx.guardProfile.updateMany({
              where: { id, ...versionGuard(current) },
              data: {
                ...rest,
                ...(guards === undefined ? {} : { guards: toJson(guardInstancesSchema.parse(guards)) }),
                ...(settings === undefined ? {} : { settings: toJson(guardSettingsSchema.parse(settings)) }),
                updatedAt: nextUpdatedAt(current),
              },
            }),
          ),
        );
        const row = await tx.guardProfile.findUniqueOrThrow({ where: { id } });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'guard_profile.update',
          targetType: 'guard_profile',
          targetId: id,
          diff: { before: toProfile(current), after: toProfile(row) },
        });
        return toProfile(row);
      });
    },
    /** Makes one profile the org default (clears the flag elsewhere) and mirrors it into org settings. */
    setOrgDefault(id: string | null, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        if (id !== null && (await tx.guardProfile.count({ where: { id } })) === 0) {
          throw new NotFoundError('guard profile', id);
        }
        await tx.guardProfile.updateMany({
          where: { isOrgDefault: true, ...(id === null ? {} : { NOT: { id } }) },
          data: { isOrgDefault: false },
        });
        if (id !== null) await tx.guardProfile.update({ where: { id }, data: { isOrgDefault: true } });
        await createOrgSettingsRepository({ ...ctx, db: tx, unit }).set(
          'guards',
          { orgDefaultProfileId: id },
          {},
        );
        unit.audit(audit, {
          action: 'guard_profile.set_default',
          targetType: 'guard_profile',
          targetId: id,
          diff: { before: null, after: { orgDefaultProfileId: id } },
        });
      });
    },
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.guardProfile.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('guard profile', id);
        assertIfMatch(current, opts.ifMatch);
        if (current.isOrgDefault) throw new ConflictError('the org default profile cannot be deleted', { id });
        const used = await tx.catalogVersion.count({ where: { guardProfileId: id } });
        if (used > 0) throw new ConflictError('guard profile is used by catalog versions', { used });
        assertSwapped(await tx.guardProfile.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'guard_profile.delete',
          targetType: 'guard_profile',
          targetId: id,
          diff: { before: { name: current.name }, after: null },
        });
      });
    },
  };
};

// --- definition_pins and drift_reviews (13.6) ----------------------------------------------------------------------------------------

const itemKindSchema = z.enum(ITEM_KINDS);

/** A pin set belongs to a catalog version or, for personal installations, to the installation (13.6). */
export type PinSubject = { catalogVersionId: string } | { installationId: string };

export type PinInput = {
  itemKind: (typeof ITEM_KINDS)[number];
  itemKey: string;
  /** Lowercase hex SHA-256 (`pinDefinition`). */
  hash: string;
  definition: Record<string, unknown>;
  approvedBy?: string | null;
};

export type PinView = PinInput & { id: string; approvedAt: Date | null; createdAt: Date };

const subjectColumns = (s: PinSubject) =>
  'catalogVersionId' in s
    ? { catalogVersionId: s.catalogVersionId, installationId: null }
    : { catalogVersionId: null, installationId: s.installationId };

const toPin = (r: DefinitionPin): PinView => ({
  id: r.id,
  itemKind: itemKindSchema.parse(r.itemKind),
  itemKey: r.itemKey,
  hash: bytesToHex(r.hash),
  definition: objectSchema.parse(r.definition),
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  createdAt: r.createdAt,
});

/** `definition_pins`: the pinned hash of every tool, prompt, resource and template of a subject. */
export const createDefinitionPinRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async list(subject: PinSubject): Promise<PinView[]> {
      const rows = await db.definitionPin.findMany({
        where: { catalogVersionId: subjectColumns(subject).catalogVersionId, installationId: subjectColumns(subject).installationId },
        orderBy: [{ itemKind: 'asc' }, { itemKey: 'asc' }],
      });
      return rows.map(toPin);
    },

    /** `PinSet` of `@bastion-mcp/guards`: `{ "<kind>:<key>": hexHash }`; null when nothing is pinned (first use). */
    async pinSet(subject: PinSubject): Promise<Record<string, string> | null> {
      const pins = await this.list(subject);
      if (pins.length === 0) return null;
      return Object.fromEntries(pins.map((p) => [`${p.itemKind}:${p.itemKey}`, p.hash]));
    },

    /** Inserts or updates pins by `(subject, kind, key)`; idempotent on the unique expression index. */
    upsertPins(subject: PinSubject, pins: readonly PinInput[], audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const cols = subjectColumns(subject);
        for (const pin of pins) {
          itemKindSchema.parse(pin.itemKind);
          await tx.$executeRaw`
            INSERT INTO definition_pins
              (id, catalog_version_id, installation_id, item_kind, item_key, hash, definition, approved_by, approved_at)
            VALUES
              (${newId()}::uuid, ${cols.catalogVersionId}::uuid, ${cols.installationId}::uuid, ${pin.itemKind},
               ${pin.itemKey}, decode(${pin.hash}, 'hex'), ${JSON.stringify(pin.definition)}::jsonb,
               ${pin.approvedBy ?? null}::uuid, ${pin.approvedBy ? new Date() : null})
            ON CONFLICT ((COALESCE(catalog_version_id, installation_id)), item_kind, item_key) DO UPDATE SET
              hash = EXCLUDED.hash, definition = EXCLUDED.definition,
              approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`;
        }
        if (pins.length > 0) {
          unit.audit(audit, {
            action: 'definition_pin.upsert',
            targetType: 'catalogVersionId' in subject ? 'catalog_version' : 'installation',
            targetId: 'catalogVersionId' in subject ? subject.catalogVersionId : subject.installationId,
            diff: { before: null, after: { items: pins.map((p) => `${p.itemKind}:${p.itemKey}`) } },
          });
        }
      });
    },

    /** Drops pins whose item vanished upstream and was approved as removed. */
    async remove(subject: PinSubject, itemKind: PinInput['itemKind'], itemKey: string): Promise<boolean> {
      const cols = subjectColumns(subject);
      const res = await db.definitionPin.deleteMany({
        where: { catalogVersionId: cols.catalogVersionId, installationId: cols.installationId, itemKind, itemKey },
      });
      return res.count > 0;
    },
  };
};

export type DriftReviewView = {
  id: string;
  catalogVersionId: string | null;
  installationId: string | null;
  itemKind: (typeof ITEM_KINDS)[number];
  itemKey: string;
  oldHash: string | null;
  newHash: string;
  newDefinition: Record<string, unknown>;
  guardResults: unknown[];
  status: (typeof REVIEW_STATUSES)[number];
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  createdAt: Date;
};

const toReview = (r: DriftReview): DriftReviewView => ({
  id: r.id,
  catalogVersionId: r.catalogVersionId,
  installationId: r.installationId,
  itemKind: itemKindSchema.parse(r.itemKind),
  itemKey: r.itemKey,
  oldHash: r.oldHash === null ? null : bytesToHex(r.oldHash),
  newHash: bytesToHex(r.newHash),
  newDefinition: objectSchema.parse(r.newDefinition),
  guardResults: z.array(z.unknown()).parse(r.guardResults),
  status: z.enum(REVIEW_STATUSES).parse(r.status),
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  reason: r.reason,
  createdAt: r.createdAt,
});

/** `drift_reviews`: the queue of changed or added definitions waiting for an owner (13.6). */
export const createDriftReviewRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<DriftReviewView | null> {
      const row = await db.driftReview.findUnique({ where: { id } });
      return row ? toReview(row) : null;
    },

    async list(
      filter: {
        status?: DriftReviewView['status'];
        catalogVersionId?: string;
        installationId?: string;
        limit?: number;
        cursor?: string;
      } = {},
    ): Promise<Paged<DriftReviewView>> {
      const limit = clampLimit(filter.limit);
      const rows = await db.driftReview.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.catalogVersionId ? { catalogVersionId: filter.catalogVersionId } : {}),
          ...(filter.installationId ? { installationId: filter.installationId } : {}),
          ...afterIdDesc(filter.cursor),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const page = toPage(rows, limit, idCursorOf);
      return { items: page.items.map(toReview), nextCursor: page.nextCursor };
    },

    /** Opens a review; a second report of the same change reuses the open one. */
    open(
      subject: PinSubject,
      input: {
        itemKind: DriftReviewView['itemKind'];
        itemKey: string;
        oldHash: string | null;
        newHash: string;
        newDefinition: Record<string, unknown>;
        guardResults?: unknown[];
      },
    ): Promise<{ review: DriftReviewView; created: boolean }> {
      return mutate(ctx, async (tx, unit) => {
        const cols = subjectColumns(subject);
        const existing = await tx.driftReview.findFirst({
          where: { ...cols, itemKind: input.itemKind, itemKey: input.itemKey, newHash: hexToBytes(input.newHash), status: 'open' },
        });
        if (existing) return { review: toReview(existing), created: false };
        const row = await tx.driftReview.create({
          data: {
            id: newId(),
            ...cols,
            itemKind: input.itemKind,
            itemKey: input.itemKey,
            oldHash: input.oldHash === null ? null : hexToBytes(input.oldHash),
            newHash: hexToBytes(input.newHash),
            newDefinition: toJson(input.newDefinition),
            guardResults: toJson(input.guardResults ?? []),
          },
        });
        if (cols.catalogVersionId) {
          const v = await tx.catalogVersion.findUnique({ where: { id: cols.catalogVersionId }, select: { entryId: true } });
          if (v) unit.bump('catalog', v.entryId);
        }
        if (cols.installationId) unit.bump('installation', cols.installationId);
        return { review: toReview(row), created: true };
      });
    },

    /**
     * Approves or rejects an open review. Approval re-pins the item to the reviewed definition in the same
     * transaction and bumps the configuration version so workers recompile (13.6).
     */
    decide(
      id: string,
      decision: { status: 'approved' | 'rejected'; decidedBy: string; reason?: string | null },
      audit?: AuditContext,
    ): Promise<DriftReviewView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.driftReview.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('drift review', id);
        const res = await tx.driftReview.updateMany({
          where: { id, status: 'open' },
          data: {
            status: decision.status,
            decidedBy: decision.decidedBy,
            decidedAt: new Date(),
            reason: decision.reason ?? null,
          },
        });
        if (res.count === 0) throw new ConflictError('drift review was already decided', { id, status: current.status });
        if (decision.status === 'approved') {
          await tx.$executeRaw`
            INSERT INTO definition_pins
              (id, catalog_version_id, installation_id, item_kind, item_key, hash, definition, approved_by, approved_at)
            VALUES
              (${newId()}::uuid, ${current.catalogVersionId}::uuid, ${current.installationId}::uuid, ${current.itemKind},
               ${current.itemKey}, ${current.newHash}, ${JSON.stringify(current.newDefinition)}::jsonb,
               ${decision.decidedBy}::uuid, now())
            ON CONFLICT ((COALESCE(catalog_version_id, installation_id)), item_kind, item_key) DO UPDATE SET
              hash = EXCLUDED.hash, definition = EXCLUDED.definition,
              approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`;
          if (current.catalogVersionId) {
            const v = await tx.catalogVersion.findUnique({ where: { id: current.catalogVersionId }, select: { entryId: true } });
            if (v) unit.bump('catalog', v.entryId);
          }
          if (current.installationId) unit.bump('installation', current.installationId);
        }
        const row = await tx.driftReview.findUniqueOrThrow({ where: { id } });
        unit.audit(audit, {
          action: `drift_review.${decision.status}`,
          targetType: 'drift_review',
          targetId: id,
          diff: {
            before: { status: 'open' },
            after: { status: decision.status, item: `${current.itemKind}:${current.itemKey}`, reason: decision.reason ?? null },
          },
        });
        return toReview(row);
      });
    },
  };
};
