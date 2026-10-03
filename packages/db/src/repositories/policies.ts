import { newId, POLICY_EFFECTS, RISK_LEVELS } from '@bastion-mcp/core';
import { z } from 'zod';
import type { PolicyRule } from '../generated/client';
import { visibilitySchema } from './catalog';
import { createOrgSettingsRepository } from './org';
import {
  type AuditContext,
  afterKey,
  assertIfMatch,
  assertSwapped,
  etagOf,
  idCursorOf,
  mutate,
  NotFoundError,
  orConflict,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  versionedUpdate,
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
export const createPolicyRuleRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
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
      return paginate(
        filter,
        (take) =>
          db.policyRule.findMany({
            where: {
              ...(filter.ownerTeamId ? { ownerTeamId: filter.ownerTeamId } : {}),
              ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
              ...afterKey('id', 'desc', filter.cursor),
            },
            orderBy: { id: 'desc' },
            take,
          }),
        idCursorOf,
        toPolicyRule,
      );
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
        const { current, row } = await versionedUpdate({
          what: 'policy rule',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.policyRule.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            const { who, what, when, ...rest } = patch;
            return tx.policyRule.updateMany({
              where,
              data: {
                ...rest,
                ...(who === undefined ? {} : { who: toJson(objectSchema.parse(who)) }),
                ...(what === undefined ? {} : { what: toJson(objectSchema.parse(what)) }),
                ...(when === undefined ? {} : { when: toJson(objectSchema.parse(when)) }),
                updatedAt,
              },
            });
          },
          reload: () => tx.policyRule.findUniqueOrThrow({ where: { id } }),
        });
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
export const createCustomPolicyRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
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
      input: {
        id?: string;
        name: string;
        cedar: string;
        tests?: unknown[];
        enabled?: boolean;
        createdBy: string;
      },
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
        const { current, row } = await versionedUpdate({
          what: 'custom policy',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.customPolicy.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            const { tests, ...rest } = patch;
            return orConflict('custom policy', () =>
              tx.customPolicy.updateMany({
                where,
                data: {
                  ...rest,
                  ...(tests === undefined ? {} : { tests: toJson(tests) }),
                  updatedAt,
                },
              }),
            );
          },
          reload: () => tx.customPolicy.findUniqueOrThrow({ where: { id } }),
        });
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
        assertSwapped(
          await tx.customPolicy.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
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
      const [orgSettings, publishers, teams, entries, installations, accounts, rules, custom] =
        await Promise.all([
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
          db.policyRule.findMany({
            where: { enabled: true },
            orderBy: [{ priority: 'asc' }, { id: 'asc' }],
          }),
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
        catalogEntries: entries.map((e) => ({
          id: e.id,
          ...(entryAttrs.get(e.id) as NonNullable<ReturnType<typeof entryAttrs.get>>),
        })),
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
                  ...(serviceTeam.has(i.ownerId)
                    ? { ownerServiceTeamId: serviceTeam.get(i.ownerId) as string }
                    : {}),
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
