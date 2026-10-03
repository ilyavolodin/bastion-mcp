import { newId as coreNewId, isValidSlug, sha256Hex, slugify } from '@bastion-mcp/core';
import { z } from 'zod';
import { type Clock, systemClock } from '../ports';
import { type IdpConnection, isEmailDomainAllowed } from '../provisioning/claims';
import {
  type MembershipState,
  type ProvisioningEvent,
  type ProvisioningPlan,
  reconcileMemberships,
  type UserChange,
  type UserState,
} from '../provisioning/plan';
import { type DesiredMembership, evaluateRules, type TeamRef } from '../provisioning/rules';
import { parseScimFilter } from './filter';
import { applyUserPatch, parseGroupPatch, parsePatchOps, toBoolean, type UserDraft } from './patch';
import {
  SCIM_CONTENT_TYPE,
  SCIM_SCHEMAS,
  type ScimDeactivator,
  ScimError,
  type ScimGroupRecord,
  type ScimListQuery,
  type ScimRequest,
  type ScimResponse,
  type ScimStore,
  ScimStoreConflictError,
  type ScimTokenRepository,
  type ScimUserRecord,
  scimErrorBody,
} from './types';

const MAX_PAGE = 200;
const DEFAULT_PAGE = 100;

export type ScimServiceDeps = {
  store: ScimStore;
  tokens: ScimTokenRepository;
  deactivator: ScimDeactivator;
  /** `https://<host>`, for `meta.location`. */
  baseUrl: string;
  /** The IdP connection SCIM provisions for (domain restriction and rule scope); null when unset. */
  connection?: IdpConnection | null;
  clock?: Clock;
  newId?: () => string;
  /** Receives unexpected failures (the response stays a generic 500). */
  logger?: ScimLogger;
};

export type ScimLogger = { error(message: string, fields?: Record<string, unknown>): void };

const boolish = z.union([z.boolean(), z.string()]).transform((v) => toBoolean(v));

const userBodySchema = z.object({
  userName: z.string().min(1).max(320),
  externalId: z.string().max(256).nullish(),
  displayName: z.string().max(256).optional(),
  name: z
    .object({
      formatted: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
    })
    .optional(),
  emails: z.array(z.object({ value: z.string(), primary: z.boolean().optional() })).optional(),
  active: boolish.optional(),
});

const groupBodySchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  members: z.array(z.object({ value: z.string().min(1) })).optional(),
});

const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** Splits a display name into given and family names (the first word is the given name). */
const splitName = (displayName: string): { given: string | null; family: string | null } => {
  const [given, ...family] = displayName.split(' ');
  return { given: given ?? null, family: family.length > 0 ? family.join(' ') : null };
};

export class ScimService {
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly connection: IdpConnection | null;

  constructor(private readonly deps: ScimServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => coreNewId());
    this.connection = deps.connection ?? null;
  }

  /** Handles one request below `/scim/v2`; never throws, errors become SCIM error responses. */
  async handle(req: ScimRequest): Promise<ScimResponse> {
    try {
      await this.authenticate(req.headers);
      return await this.route(req);
    } catch (e) {
      if (e instanceof ScimError) return this.json(e.status, scimErrorBody(e));
      if (e instanceof ScimStoreConflictError) {
        return this.json(
          409,
          scimErrorBody(new ScimError(409, 'resource already exists', 'uniqueness')),
        );
      }
      this.deps.logger?.error('scim request failed', {
        error: e,
        method: req.method,
        path: req.path,
      });
      return this.json(500, scimErrorBody(new ScimError(500, 'internal error')));
    }
  }

  /** 9.1: bearer token checked against `scim_tokens` by SHA-256. */
  private async authenticate(headers: Record<string, string | undefined>): Promise<void> {
    const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
    const m = /^Bearer\s+(\S+)$/i.exec(entry?.[1] ?? '');
    const unauthorized = new ScimError(401, 'invalid or missing bearer token');
    if (!m?.[1]) throw unauthorized;
    const token = await this.deps.tokens.findByHash(sha256Hex(m[1]));
    const now = this.clock.now();
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= now)) {
      throw unauthorized;
    }
  }

  private async route(req: ScimRequest): Promise<ScimResponse> {
    const segments = req.path.split('/').filter(Boolean);
    const [resource, id, ...rest] = segments;
    const method = req.method.toUpperCase();
    if (rest.length > 0) throw new ScimError(404, 'resource not found');
    switch (resource?.toLowerCase()) {
      case 'serviceproviderconfig':
        return this.json(200, this.serviceProviderConfig());
      case 'resourcetypes':
        return this.json(200, this.resourceTypes());
      case 'schemas':
        return this.json(200, this.list([], 0, 1));
      case 'users':
        return this.users(method, id, req);
      case 'groups':
        return this.groups(method, id, req);
      default:
        throw new ScimError(404, 'resource not found');
    }
  }

  /* ------------------------------ users ------------------------------ */

  private async users(
    method: string,
    id: string | undefined,
    req: ScimRequest,
  ): Promise<ScimResponse> {
    if (!id) {
      if (method === 'GET') {
        return this.listResponse(
          req.query,
          (q) => this.deps.store.listUsers(q),
          (u) => this.userResource(u),
        );
      }
      if (method === 'POST') return this.createUser(req.body);
      throw new ScimError(405, 'method not allowed');
    }
    const record = await this.deps.store.getUser(id);
    if (!record) throw new ScimError(404, 'User not found');
    switch (method) {
      case 'GET':
        return this.json(200, this.userResource(record));
      case 'PUT':
        return this.updateUser(record, this.draftFromBody(req.body, record));
      case 'PATCH':
        return this.updateUser(
          record,
          applyUserPatch(this.draftFromRecord(record), parsePatchOps(req.body)),
        );
      case 'DELETE':
        if (record.active) await this.deps.deactivator.deactivate(record.id);
        return { status: 204, headers: {}, body: null };
      default:
        throw new ScimError(405, 'method not allowed');
    }
  }

  /** Lowercased, trimmed email that must look like an address and be in an allowed domain (9.1). */
  private checkedEmail(raw: string): string {
    const email = raw.trim().toLowerCase();
    if (!EMAIL.test(email))
      throw new ScimError(400, 'userName must be an email address', 'invalidValue');
    if (this.connection && !isEmailDomainAllowed(email, this.connection.emailDomains)) {
      throw new ScimError(400, 'email domain is not allowed', 'invalidValue');
    }
    return email;
  }

  private parseUserBody(body: unknown) {
    const parsed = userBodySchema.safeParse(body);
    if (!parsed.success) throw new ScimError(400, 'invalid User resource', 'invalidSyntax');
    const b = parsed.data;
    const primary = b.emails?.find((e) => e.primary)?.value ?? b.emails?.[0]?.value;
    const email = this.checkedEmail(EMAIL.test(b.userName) ? b.userName : (primary ?? b.userName));
    const composed = [b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ');
    const displayName =
      b.displayName?.trim() ||
      b.name?.formatted?.trim() ||
      composed ||
      (email.split('@')[0] ?? email);
    return { email, displayName, externalId: b.externalId ?? null, active: b.active ?? true };
  }

  private async createUser(body: unknown): Promise<ScimResponse> {
    const u = this.parseUserBody(body);
    if (await this.deps.store.findUserIdByEmail(u.email)) {
      throw new ScimError(409, 'a user with this userName already exists', 'uniqueness');
    }
    const id = this.newId();
    const plan: ProvisioningPlan = {
      user: {
        kind: 'create',
        id,
        email: u.email,
        displayName: u.displayName,
        orgRole: 'member',
        idpConnectionId: this.connection?.id ?? null,
        externalSubject: null,
        status: u.active ? 'active' : 'deactivated',
        scimExternalId: u.externalId,
      },
      createTeams: [],
      membershipUpserts: [],
      membershipRemovals: [],
      events: [{ type: 'user.created', userId: id, email: u.email }],
      warnings: [],
    };
    await this.deps.store.applyPlans([plan]);
    const created = await this.deps.store.getUser(id);
    if (!created) throw new ScimError(500, 'created user not found');
    return this.json(201, this.userResource(created), { location: this.location('Users', id) });
  }

  private draftFromRecord(r: ScimUserRecord): UserDraft {
    const { given, family } = splitName(r.displayName);
    return {
      userName: r.userName,
      displayName: r.displayName,
      externalId: r.externalId,
      active: r.active,
      givenName: given,
      familyName: family,
      nameTouched: false,
    };
  }

  private draftFromBody(body: unknown, r: ScimUserRecord): UserDraft {
    const u = this.parseUserBody(body);
    return {
      ...this.draftFromRecord(r),
      userName: u.email,
      displayName: u.displayName,
      externalId: u.externalId,
      active: u.active,
    };
  }

  /** Shared by PUT and PATCH: diff the draft against the record and apply it (9.1). */
  private async updateUser(record: ScimUserRecord, draft: UserDraft): Promise<ScimResponse> {
    const changes: Extract<UserChange, { kind: 'update' }>['changes'] = {};
    const email = draft.userName.trim().toLowerCase();
    if (!EMAIL.test(email))
      throw new ScimError(400, 'userName must be an email address', 'invalidValue');
    if (email !== record.userName.toLowerCase()) {
      this.checkedEmail(email);
      const owner = await this.deps.store.findUserIdByEmail(email);
      if (owner && owner !== record.id) {
        throw new ScimError(409, 'a user with this userName already exists', 'uniqueness');
      }
      changes.email = email;
    }
    if (draft.displayName !== record.displayName) changes.displayName = draft.displayName;
    if (draft.externalId !== record.externalId) changes.scimExternalId = draft.externalId;
    const deactivating = record.active && !draft.active;
    if (!record.active && draft.active) changes.status = 'active';
    const events: ProvisioningEvent[] = deactivating
      ? [{ type: 'user.deactivated', userId: record.id }]
      : [];
    if (Object.keys(changes).length > 0) {
      await this.deps.store.applyPlans([
        {
          user: { kind: 'update', id: record.id, changes },
          createTeams: [],
          membershipUpserts: [],
          membershipRemovals: [],
          events,
          warnings: [],
        },
      ]);
    }
    // `active: false` = deactivate: tokens, sessions, instances and upstream tokens (9.1).
    if (deactivating) await this.deps.deactivator.deactivate(record.id);
    const updated = await this.deps.store.getUser(record.id);
    if (!updated) throw new ScimError(404, 'User not found');
    return this.json(200, this.userResource(updated));
  }

  /* ------------------------------ groups ------------------------------ */

  private async groups(
    method: string,
    id: string | undefined,
    req: ScimRequest,
  ): Promise<ScimResponse> {
    if (!id) {
      if (method === 'GET') {
        return this.listResponse(
          req.query,
          (q) => this.deps.store.listGroups(q),
          (g) => this.groupResource(g),
        );
      }
      if (method === 'POST') return this.createGroup(req.body);
      throw new ScimError(405, 'method not allowed');
    }
    const group = await this.deps.store.getGroup(id);
    if (!group) throw new ScimError(404, 'Group not found');
    switch (method) {
      case 'GET':
        return this.json(200, this.groupResource(group));
      case 'PUT': {
        const b = this.parseGroupBody(req.body);
        return this.changeGroup(group, {
          displayName: b.displayName,
          target: b.members,
        });
      }
      case 'PATCH': {
        const p = parseGroupPatch(parsePatchOps(req.body));
        const current = group.members.map((m) => m.id);
        const target =
          p.replaceMembers ??
          [...new Set([...current, ...p.addMembers])].filter((m) => !p.removeMembers.includes(m));
        return this.changeGroup(group, {
          ...(p.displayName === undefined ? {} : { displayName: p.displayName }),
          target,
        });
      }
      case 'DELETE': {
        await this.changeMembers(
          group,
          [],
          group.members.map((m) => m.id),
        );
        await this.deps.store.detachGroup(group.id);
        return { status: 204, headers: {}, body: null };
      }
      default:
        throw new ScimError(405, 'method not allowed');
    }
  }

  private parseGroupBody(body: unknown) {
    const parsed = groupBodySchema.safeParse(body);
    if (!parsed.success) throw new ScimError(400, 'invalid Group resource', 'invalidSyntax');
    return {
      displayName: parsed.data.displayName,
      members: [...new Set((parsed.data.members ?? []).map((m) => m.value))],
    };
  }

  private async createGroup(body: unknown): Promise<ScimResponse> {
    const b = this.parseGroupBody(body);
    if (await this.deps.store.findGroupByName(b.displayName)) {
      throw new ScimError(409, 'a group with this displayName already exists', 'uniqueness');
    }
    const slug = slugify(b.displayName);
    if (!isValidSlug(slug))
      throw new ScimError(400, 'displayName cannot be used as a team name', 'invalidValue');
    const team = { id: this.newId(), slug, displayName: b.displayName, idpGroup: b.displayName };
    const group: ScimGroupRecord = {
      id: team.id,
      displayName: b.displayName,
      members: [],
      createdAt: new Date(this.clock.now()),
      updatedAt: null,
    };
    const memberPlans = await this.membershipPlans(group, b.members, [], [team]);
    // The new team rides on the first plan (or on a plan of its own when there are no members to add).
    const [first, ...others] = memberPlans;
    const plans: ProvisioningPlan[] = first
      ? [{ ...first, createTeams: [...first.createTeams, team] }, ...others]
      : [
          {
            user: { kind: 'none', id: team.id },
            createTeams: [team],
            membershipUpserts: [],
            membershipRemovals: [],
            events: [],
            warnings: [],
          },
        ];
    await this.deps.store.applyPlans(plans);
    const created = await this.deps.store.getGroup(team.id);
    if (!created) throw new ScimError(500, 'created group not found');
    return this.json(201, this.groupResource(created), {
      location: this.location('Groups', team.id),
    });
  }

  private async changeGroup(
    group: ScimGroupRecord,
    input: { displayName?: string; target: string[] },
  ): Promise<ScimResponse> {
    if (input.displayName && input.displayName !== group.displayName) {
      await this.deps.store.renameGroup(group.id, input.displayName);
    }
    const current = group.members.map((m) => m.id);
    const target = [...new Set(input.target)];
    await this.changeMembers(
      group,
      target.filter((m) => !current.includes(m)),
      current.filter((m) => !target.includes(m)),
    );
    const updated = await this.deps.store.getGroup(group.id);
    if (!updated) throw new ScimError(404, 'Group not found');
    return this.json(200, this.groupResource(updated));
  }

  private async changeMembers(
    group: ScimGroupRecord,
    added: string[],
    removed: string[],
  ): Promise<void> {
    const plans = await this.membershipPlans(group, added, removed, []);
    if (plans.length > 0) await this.deps.store.applyPlans(plans);
  }

  /** One plan per affected user: SCIM membership, then org role and rule-mapped teams re-evaluated (9.1). */
  private async membershipPlans(
    group: { id: string; displayName: string },
    added: readonly string[],
    removed: readonly string[],
    newTeams: readonly TeamRef[],
  ): Promise<ProvisioningPlan[]> {
    if (added.length === 0 && removed.length === 0) return [];
    const teams = [...(await this.deps.store.listTeamRefs()), ...newTeams];
    const rules = await this.deps.store.listRules(this.connection?.id ?? null);
    const plans: ProvisioningPlan[] = [];
    for (const userId of [...added, ...removed]) {
      const user = await this.deps.store.getUserState(userId);
      if (!user) throw new ScimError(400, `unknown member ${userId}`, 'invalidValue');
      const groups = (await this.deps.store.userScimGroups(userId)).filter(
        (g) => g.teamId !== group.id,
      );
      if (added.includes(userId)) groups.push({ teamId: group.id, name: group.displayName });
      plans.push(
        planScimMemberships({
          user,
          groups,
          rules,
          teams,
          connectionId: this.connection?.id ?? '',
          newId: this.newId,
        }),
      );
    }
    return plans;
  }

  /* ----------------------------- rendering ----------------------------- */

  private location(kind: 'Users' | 'Groups', id: string): string {
    return `${this.deps.baseUrl}/scim/v2/${kind}/${id}`;
  }

  private userResource(u: ScimUserRecord) {
    const { given, family } = splitName(u.displayName);
    return {
      schemas: [SCIM_SCHEMAS.user],
      id: u.id,
      ...(u.externalId ? { externalId: u.externalId } : {}),
      userName: u.userName,
      name: {
        formatted: u.displayName,
        ...(given ? { givenName: given } : {}),
        ...(family ? { familyName: family } : {}),
      },
      displayName: u.displayName,
      emails: [{ value: u.userName, type: 'work', primary: true }],
      active: u.active,
      meta: {
        resourceType: 'User',
        created: u.createdAt.toISOString(),
        lastModified: (u.updatedAt ?? u.createdAt).toISOString(),
        location: this.location('Users', u.id),
      },
    };
  }

  private groupResource(g: ScimGroupRecord) {
    return {
      schemas: [SCIM_SCHEMAS.group],
      id: g.id,
      displayName: g.displayName,
      members: g.members.map((m) => ({
        value: m.id,
        display: m.display,
        $ref: this.location('Users', m.id),
      })),
      meta: {
        resourceType: 'Group',
        created: g.createdAt.toISOString(),
        lastModified: (g.updatedAt ?? g.createdAt).toISOString(),
        location: this.location('Groups', g.id),
      },
    };
  }

  /** Shared `GET /Users` and `GET /Groups`: parse the query, page the store, render the list envelope. */
  private async listResponse<R>(
    query: Record<string, string | undefined>,
    fetchPage: (q: ScimListQuery) => Promise<{ total: number; items: R[] }>,
    render: (item: R) => unknown,
  ): Promise<ScimResponse> {
    const q = this.listQuery(query);
    const { total, items } = await fetchPage(q);
    return this.json(200, this.list(items.map(render), total, q.startIndex));
  }

  private list(resources: unknown[], total: number, startIndex: number) {
    return {
      schemas: [SCIM_SCHEMAS.list],
      totalResults: total,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  private listQuery(query: Record<string, string | undefined>): ScimListQuery {
    const startIndex = Math.max(1, Number.parseInt(query.startIndex ?? '1', 10) || 1);
    const rawCount = Number.parseInt(query.count ?? String(DEFAULT_PAGE), 10);
    const count = Number.isFinite(rawCount)
      ? Math.min(Math.max(rawCount, 0), MAX_PAGE)
      : DEFAULT_PAGE;
    return { filter: query.filter ? parseScimFilter(query.filter) : null, startIndex, count };
  }

  private serviceProviderConfig() {
    return {
      schemas: [SCIM_SCHEMAS.serviceProvider],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'SCIM token created in the Bastion admin UI',
        },
      ],
    };
  }

  private resourceTypes() {
    return this.list(
      [
        {
          schemas: [SCIM_SCHEMAS.resourceType],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: SCIM_SCHEMAS.user,
        },
        {
          schemas: [SCIM_SCHEMAS.resourceType],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: SCIM_SCHEMAS.group,
        },
      ],
      2,
      1,
    );
  }

  private json(status: number, body: unknown, extra: Record<string, string> = {}): ScimResponse {
    return { status, headers: { 'content-type': SCIM_CONTENT_TYPE, ...extra }, body };
  }
}

/**
 * Pure plan for a change of a user's SCIM group set (9.1): memberships of source `scim` follow the groups,
 * and the org role plus rule-mapped teams are re-evaluated against the group names.
 */
export const planScimMemberships = (input: {
  user: UserState;
  groups: readonly { teamId: string; name: string }[];
  rules: Parameters<typeof evaluateRules>[0]['rules'];
  teams: readonly TeamRef[];
  connectionId: string;
  newId: () => string;
}): ProvisioningPlan => {
  const evaluation = evaluateRules({
    rules: input.rules,
    connectionId: input.connectionId,
    groups: input.groups.map((g) => g.name),
    existingTeams: input.teams,
    newId: input.newId,
  });
  const fresh = new Set(evaluation.createTeams.map((t) => t.id));
  const desired = new Map<string, DesiredMembership['role']>();
  const put = (teamId: string, role: DesiredMembership['role']) =>
    desired.set(
      teamId,
      desired.get(teamId) === 'manager' || role === 'manager' ? 'manager' : 'member',
    );
  for (const g of input.groups) put(g.teamId, 'member');
  for (const m of evaluation.memberships) if (!fresh.has(m.teamId)) put(m.teamId, m.role);

  const rec = reconcileMemberships({
    userId: input.user.id,
    source: 'scim',
    desired: [...desired].map(([teamId, role]) => ({ teamId, role })),
    current: input.user.memberships as readonly MembershipState[],
  });
  const events: ProvisioningEvent[] = rec.added.map((m) => ({
    type: 'team.member_added',
    userId: input.user.id,
    teamId: m.teamId,
    role: m.role,
  }));
  const changes: Extract<UserChange, { kind: 'update' }>['changes'] = {};
  if (evaluation.orgRoleManaged) {
    const role = evaluation.orgRole ?? 'member';
    if (role !== input.user.orgRole) {
      changes.orgRole = role;
      events.push({
        type: 'user.role_changed',
        userId: input.user.id,
        from: input.user.orgRole,
        to: role,
      });
    }
  }
  return {
    user: { kind: 'update', id: input.user.id, changes },
    createTeams: [],
    membershipUpserts: rec.upserts,
    membershipRemovals: rec.removals,
    events,
    warnings: evaluation.warnings,
  };
};
