import { sha256Hex } from '@bastion-mcp/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyUserPatch,
  evaluateFilter,
  type FilterNode,
  type ProvisioningPlan,
  parseGroupPatch,
  parsePatchOps,
  parseScimFilter,
  type RoleMappingRule,
  SCIM_SCHEMAS,
  ScimError,
  type ScimGroupRecord,
  type ScimListQuery,
  type ScimRequest,
  ScimService,
  type ScimStore,
  ScimStoreConflictError,
  type ScimUserRecord,
  simpleEquality,
  type TeamRef,
  type UserState,
} from '../../src/identity';
import { FakeClock } from './helpers';

/* ------------------------------ in-memory store ------------------------------ */

type U = ScimUserRecord & { orgRole: 'admin' | 'auditor' | 'member' };
type T = {
  id: string;
  slug: string;
  displayName: string;
  idpGroup: string | null;
  createdAt: Date;
};
type M = {
  teamId: string;
  userId: string;
  role: 'manager' | 'member';
  source: 'manual' | 'idp' | 'scim';
};

class MemoryScimStore implements ScimStore {
  users = new Map<string, U>();
  teams = new Map<string, T>();
  memberships: M[] = [];
  rules: RoleMappingRule[] = [];
  events: string[] = [];
  private page<X>(items: X[], q: ScimListQuery, toRes: (x: X) => Record<string, unknown>) {
    const matched = q.filter
      ? items.filter((i) => evaluateFilter(q.filter as FilterNode, toRes(i)))
      : items;
    return {
      total: matched.length,
      items: matched.slice(q.startIndex - 1, q.startIndex - 1 + q.count),
    };
  }
  async listUsers(q: ScimListQuery) {
    return this.page([...this.users.values()], q, (u) => ({ ...u }));
  }
  async getUser(id: string) {
    return this.users.get(id) ?? null;
  }
  async getUserState(id: string): Promise<UserState | null> {
    const u = this.users.get(id);
    if (!u) return null;
    return {
      id,
      email: u.userName,
      displayName: u.displayName,
      orgRole: u.orgRole,
      status: u.active ? 'active' : 'deactivated',
      idpConnectionId: null,
      externalSubject: null,
      isLocal: false,
      memberships: this.memberships.filter((m) => m.userId === id),
    };
  }
  async findUserIdByEmail(email: string) {
    return [...this.users.values()].find((u) => u.userName === email)?.id ?? null;
  }
  private group(t: T): ScimGroupRecord {
    return {
      id: t.id,
      displayName: t.displayName,
      createdAt: t.createdAt,
      updatedAt: null,
      members: this.memberships
        .filter((m) => m.teamId === t.id && m.source === 'scim')
        .map((m) => ({ id: m.userId, display: this.users.get(m.userId)?.displayName ?? '' })),
    };
  }
  private scimTeams() {
    return [...this.teams.values()].filter((t) => t.idpGroup !== null);
  }
  async listGroups(q: ScimListQuery) {
    const r = this.page(this.scimTeams(), q, (t) => ({ displayName: t.displayName, id: t.id }));
    return { total: r.total, items: r.items.map((t) => this.group(t)) };
  }
  async getGroup(id: string) {
    const t = this.teams.get(id);
    return t && t.idpGroup !== null ? this.group(t) : null;
  }
  async findGroupByName(name: string) {
    const t = this.scimTeams().find((x) => x.idpGroup === name);
    return t ? this.group(t) : null;
  }
  async listTeamRefs(): Promise<TeamRef[]> {
    return [...this.teams.values()].map((t) => ({ id: t.id, slug: t.slug, idpGroup: t.idpGroup }));
  }
  async userScimGroups(userId: string) {
    return this.memberships
      .filter((m) => m.userId === userId && m.source === 'scim')
      .map((m) => ({ teamId: m.teamId, name: this.teams.get(m.teamId)?.idpGroup ?? '' }));
  }
  async listRules() {
    return this.rules;
  }
  async applyPlans(plans: readonly ProvisioningPlan[]) {
    for (const p of plans) {
      for (const t of p.createTeams) {
        if ([...this.teams.values()].some((x) => x.slug === t.slug))
          throw new ScimStoreConflictError('slug');
        this.teams.set(t.id, { ...t, createdAt: new Date() });
      }
      if (p.user.kind === 'create') {
        const c = p.user;
        this.users.set(c.id, {
          id: c.id,
          userName: c.email,
          displayName: c.displayName,
          externalId: c.scimExternalId ?? null,
          active: (c.status ?? 'active') === 'active',
          createdAt: new Date(),
          updatedAt: null,
          orgRole: c.orgRole,
        });
      } else if (p.user.kind === 'update') {
        const u = this.users.get(p.user.id);
        const ch = p.user.changes;
        if (u) {
          if (ch.email) u.userName = ch.email;
          if (ch.displayName) u.displayName = ch.displayName;
          if ('scimExternalId' in ch) u.externalId = ch.scimExternalId ?? null;
          if (ch.orgRole) u.orgRole = ch.orgRole;
          if (ch.status) u.active = ch.status === 'active';
        }
      }
      for (const r of p.membershipRemovals) {
        this.memberships = this.memberships.filter(
          (m) => !(m.teamId === r.teamId && m.userId === r.userId),
        );
      }
      for (const m of p.membershipUpserts) {
        this.memberships = this.memberships.filter(
          (x) => !(x.teamId === m.teamId && x.userId === m.userId),
        );
        this.memberships.push(m);
      }
      this.events.push(...p.events.map((e) => e.type));
    }
  }
  async renameGroup(id: string, displayName: string) {
    const t = this.teams.get(id);
    if (t) {
      t.displayName = displayName;
      t.idpGroup = displayName;
    }
  }
  async detachGroup(id: string) {
    const t = this.teams.get(id);
    if (t) t.idpGroup = null;
  }
}

/* ---------------------------------- setup ---------------------------------- */

const TOKEN = 'scim-secret-token';
let counter = 0;
const setup = () => {
  const clock = new FakeClock();
  const store = new MemoryScimStore();
  const deactivated: string[] = [];
  const tokens = new Map([
    [sha256Hex(TOKEN), { id: 't1', expiresAt: null, revokedAt: null as Date | null }],
    [sha256Hex('expired'), { id: 't2', expiresAt: new Date(clock.now() - 1000), revokedAt: null }],
    [sha256Hex('revoked'), { id: 't3', expiresAt: null, revokedAt: new Date(clock.now() - 1000) }],
  ]);
  const service = new ScimService({
    store,
    tokens: { findByHash: async (h) => tokens.get(h) ?? null },
    deactivator: {
      deactivate: async (id) => {
        deactivated.push(id);
        const u = store.users.get(id);
        if (u) u.active = false;
      },
    },
    baseUrl: 'https://bastion.test',
    clock,
    newId: () => `id-${++counter}`,
  });
  const call = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) =>
    service.handle({
      method,
      path,
      query,
      headers: { Authorization: `Bearer ${TOKEN}` },
      body,
    } as ScimRequest);
  return { store, service, call, deactivated };
};

const newUser = (over: Record<string, unknown> = {}) => ({
  schemas: [SCIM_SCHEMAS.user],
  userName: 'Ann@Example.com',
  externalId: 'ext-1',
  name: { givenName: 'Ann', familyName: 'Lee' },
  emails: [{ value: 'ann@example.com', primary: true }],
  active: true,
  ...over,
});

const patchBody = (...Operations: unknown[]) => ({ schemas: [SCIM_SCHEMAS.patch], Operations });

/* ---------------------------------- tests ---------------------------------- */

describe('9.1 SCIM filter parsing', () => {
  it('9.1 parses eq for userName, externalId and displayName', () => {
    for (const attr of ['userName', 'externalId', 'displayName']) {
      expect(parseScimFilter(`${attr} eq "x@y.io"`)).toEqual({ op: 'eq', attr, value: 'x@y.io' });
    }
  });

  it('9.1 parses and / or / not / parentheses with precedence', () => {
    const f = parseScimFilter('userName eq "a" and active eq true or displayName co "b"');
    expect(f).toMatchObject({ op: 'or', left: { op: 'and' }, right: { op: 'co' } });
    expect(parseScimFilter('not (active eq false)')).toMatchObject({ op: 'not' });
    expect(parseScimFilter('userName PR')).toEqual({ op: 'pr', attr: 'userName' });
    expect(parseScimFilter('x eq null')).toMatchObject({ value: null });
    expect(parseScimFilter('n eq 5')).toMatchObject({ value: 5 });
  });

  it('9.1 handles escaped quotes in values', () => {
    expect(parseScimFilter('displayName eq "a \\"b\\""')).toMatchObject({ value: 'a "b"' });
  });

  it('9.1 rejects malformed filters with invalidFilter', () => {
    for (const bad of [
      '',
      'userName',
      'userName eq',
      'userName gt "a"',
      'userName eq "a',
      '(userName eq "a"',
      'a eq "b" c',
      'a eq b',
      '"x" eq "y"',
      'x'.repeat(1001),
    ]) {
      expect(() => parseScimFilter(bad), bad).toThrow(ScimError);
    }
    try {
      parseScimFilter('bad');
    } catch (e) {
      expect(e).toMatchObject({ status: 400, scimType: 'invalidFilter' });
    }
    expect(() => parseScimFilter(`${'('.repeat(30)}a eq "b"${')'.repeat(30)}`)).toThrow(ScimError);
  });

  it('9.1 evaluates filters case-insensitively on attribute names and string values', () => {
    const r = { userName: 'Ann@Example.com', active: true, name: { givenName: 'Ann' } };
    const ev = (f: string) => evaluateFilter(parseScimFilter(f), r);
    expect(ev('USERNAME eq "ann@example.com"')).toBe(true);
    expect(ev('userName eq "x"')).toBe(false);
    expect(ev('userName ne "x"')).toBe(true);
    expect(ev('userName sw "ann" and active eq true')).toBe(true);
    expect(ev('userName ew "COM"')).toBe(true);
    expect(ev('name.givenName co "n"')).toBe(true);
    expect(ev('missing pr')).toBe(false);
    expect(ev('userName pr')).toBe(true);
    expect(ev('missing eq null')).toBe(true);
    expect(ev('missing ne null')).toBe(false);
    expect(ev('missing co "a"')).toBe(false);
    expect(ev('not (userName eq "x")')).toBe(true);
    expect(ev('userName eq "x" or active eq true')).toBe(true);
  });

  it('9.1 simpleEquality exposes single eq filters for indexed lookups', () => {
    expect(simpleEquality(parseScimFilter('userName eq "a"'))).toEqual({
      attr: 'username',
      value: 'a',
    });
    expect(simpleEquality(parseScimFilter('a eq "1" and b eq "2"'))).toBeNull();
    expect(simpleEquality(null)).toBeNull();
  });
});

describe('9.1 SCIM PATCH parsing', () => {
  it('9.1 parses operations case-insensitively and rejects bad requests', () => {
    expect(parsePatchOps(patchBody({ op: 'Replace', path: 'active', value: 'False' }))).toEqual([
      { op: 'replace', path: 'active', value: 'False' },
    ]);
    expect(() => parsePatchOps({})).toThrow(ScimError);
    expect(() => parsePatchOps(patchBody({ op: 'move' }))).toThrow(ScimError);
    expect(() => parsePatchOps({ schemas: ['x'], Operations: [] })).toThrow(ScimError);
  });

  const draft = {
    userName: 'a@b.io',
    displayName: 'A B',
    externalId: null,
    active: true,
    givenName: 'A',
    familyName: 'B',
    nameTouched: false,
  };

  it('9.1 user patch: Okta value-object form and Entra string booleans for active', () => {
    expect(
      applyUserPatch(draft, parsePatchOps(patchBody({ op: 'replace', value: { active: false } })))
        .active,
    ).toBe(false);
    expect(
      applyUserPatch(
        draft,
        parsePatchOps(patchBody({ op: 'Replace', path: 'active', value: 'False' })),
      ).active,
    ).toBe(false);
    expect(
      applyUserPatch(
        { ...draft, active: false },
        parsePatchOps(patchBody({ op: 'replace', path: 'active', value: 'True' })),
      ).active,
    ).toBe(true);
    expect(() =>
      applyUserPatch(
        draft,
        parsePatchOps(patchBody({ op: 'replace', path: 'active', value: 'maybe' })),
      ),
    ).toThrow(ScimError);
  });

  it('9.1 user patch: userName, externalId, name parts, remove externalId, ignored attributes', () => {
    const ops = parsePatchOps(
      patchBody(
        { op: 'replace', path: 'userName', value: 'New@B.io' },
        { op: 'add', path: 'externalId', value: 'e1' },
        { op: 'replace', path: 'name.givenName', value: 'Zed' },
        { op: 'replace', path: 'emails[type eq "work"].value', value: 'ignored@b.io' },
        { op: 'replace', path: 'phoneNumbers', value: [] },
      ),
    );
    const out = applyUserPatch(draft, ops);
    expect(out).toMatchObject({ userName: 'new@b.io', externalId: 'e1', displayName: 'Zed B' });
    expect(
      applyUserPatch(out, parsePatchOps(patchBody({ op: 'remove', path: 'externalId' })))
        .externalId,
    ).toBeNull();
    const viaObject = applyUserPatch(
      draft,
      parsePatchOps(
        patchBody({ op: 'replace', value: { displayName: 'Q', name: { familyName: 'R' } } }),
      ),
    );
    expect(viaObject.displayName).toBe('A R');
    expect(() =>
      applyUserPatch(draft, parsePatchOps(patchBody({ op: 'replace', value: 'x' }))),
    ).toThrow(ScimError);
    expect(() =>
      applyUserPatch(
        draft,
        parsePatchOps(patchBody({ op: 'replace', path: 'userName', value: 5 })),
      ),
    ).toThrow(ScimError);
  });

  it('9.1 group patch: Okta and Entra member operations', () => {
    const p = parseGroupPatch(
      parsePatchOps(
        patchBody(
          { op: 'add', path: 'members', value: [{ value: 'u1' }, { value: 'u2' }] },
          { op: 'remove', path: 'members[value eq "u3"]' },
          { op: 'Remove', path: 'members', value: [{ value: 'u4' }] },
          { op: 'Replace', path: 'displayName', value: ' New ' },
        ),
      ),
    );
    expect(p).toEqual({
      addMembers: ['u1', 'u2'],
      removeMembers: ['u3', 'u4'],
      replaceMembers: null,
      displayName: 'New',
    });
    expect(
      parseGroupPatch(
        parsePatchOps(patchBody({ op: 'replace', path: 'members', value: [{ value: 'a' }] })),
      ).replaceMembers,
    ).toEqual(['a']);
    expect(
      parseGroupPatch(parsePatchOps(patchBody({ op: 'remove', path: 'members' }))).replaceMembers,
    ).toEqual([]);
    expect(
      parseGroupPatch(
        parsePatchOps(
          patchBody({ op: 'add', value: { displayName: 'G', members: [{ value: 'z' }] } }),
        ),
      ).addMembers,
    ).toEqual(['z']);
    expect(
      parseGroupPatch(parsePatchOps(patchBody({ op: 'replace', value: { members: [] } })))
        .replaceMembers,
    ).toEqual([]);
    expect(() =>
      parseGroupPatch(parsePatchOps(patchBody({ op: 'replace', path: 'nickname', value: 'x' }))),
    ).toThrow(ScimError);
    expect(() =>
      parseGroupPatch(
        parsePatchOps(patchBody({ op: 'add', path: 'members[value eq "a"]', value: [] })),
      ),
    ).toThrow(ScimError);
    expect(() =>
      parseGroupPatch(parsePatchOps(patchBody({ op: 'add', path: 'members', value: [{}] }))),
    ).toThrow(ScimError);
  });
});

describe('9.1 SCIM server: authentication', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('9.1 rejects a missing, unknown, expired or revoked bearer token with a SCIM 401 error', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: 'Bearer expired' },
      { authorization: 'Bearer revoked' },
      { authorization: 'Basic abc' },
    ]) {
      const r = await s.service.handle({
        method: 'GET',
        path: '/Users',
        query: {},
        headers,
        body: undefined,
      });
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ schemas: [SCIM_SCHEMAS.error], status: '401' });
    }
  });

  it('9.1 accepts a lowercase authorization header and serves discovery endpoints', async () => {
    const r = await s.service.handle({
      method: 'GET',
      path: '/ServiceProviderConfig',
      query: {},
      headers: { authorization: `Bearer ${TOKEN}` },
      body: undefined,
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/scim+json');
    expect(r.body).toMatchObject({ patch: { supported: true }, filter: { supported: true } });
    expect((await s.call('GET', '/ResourceTypes')).body).toMatchObject({ totalResults: 2 });
    expect((await s.call('GET', '/Schemas')).status).toBe(200);
    expect((await s.call('GET', '/Nope')).status).toBe(404);
    expect((await s.call('GET', '/Users/a/b')).status).toBe(404);
  });
});

describe('9.1 SCIM server: Users', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('9.1 SCIM create = provision: 201, Location, normalized email, user.created event', async () => {
    const r = await s.call('POST', '/Users', newUser());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      schemas: [SCIM_SCHEMAS.user],
      userName: 'ann@example.com',
      externalId: 'ext-1',
      active: true,
      name: { givenName: 'Ann', familyName: 'Lee', formatted: 'Ann Lee' },
      emails: [{ value: 'ann@example.com', primary: true }],
    });
    const id = (r.body as { id: string }).id;
    expect(r.headers.location).toBe(`https://bastion.test/scim/v2/Users/${id}`);
    expect(s.store.events).toEqual(['user.created']);
  });

  it('9.1 duplicate userName is 409 uniqueness; invalid bodies are 400', async () => {
    await s.call('POST', '/Users', newUser());
    const dup = await s.call('POST', '/Users', newUser());
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ status: '409', scimType: 'uniqueness' });
    expect((await s.call('POST', '/Users', { nope: 1 })).status).toBe(400);
    expect(
      (await s.call('POST', '/Users', newUser({ userName: 'not-an-email', emails: undefined })))
        .status,
    ).toBe(400);
    expect((await s.call('POST', '/Users', newUser({ active: 'maybe' }))).status).toBe(400);
  });

  it('9.1 falls back to the primary email when userName is not an email, and active:false creates a deactivated user', async () => {
    const r = await s.call(
      'POST',
      '/Users',
      newUser({ userName: 'ann', emails: [{ value: 'a@b.io', primary: true }], active: 'False' }),
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userName: 'a@b.io', active: false });
  });

  it('9.1 enforces allowed email domains on SCIM create', async () => {
    const store = s.store;
    const svc = new ScimService({
      store,
      tokens: { findByHash: async () => ({ id: 't', expiresAt: null, revokedAt: null }) },
      deactivator: { deactivate: async () => {} },
      baseUrl: 'https://bastion.test',
      connection: {
        id: 'idp',
        issuer: 'https://i',
        claimMap: {},
        emailDomains: ['example.com'],
        enabled: true,
      },
    });
    const call = (b: unknown) =>
      svc.handle({
        method: 'POST',
        path: '/Users',
        query: {},
        headers: { authorization: 'Bearer x' },
        body: b,
      });
    expect((await call(newUser({ userName: 'x@evil.com', emails: undefined }))).status).toBe(400);
    expect((await call(newUser())).status).toBe(201);
  });

  it('9.1 lists with filters and pagination, in the ListResponse shape', async () => {
    for (const n of ['a', 'b', 'c'])
      await s.call(
        'POST',
        '/Users',
        newUser({ userName: `${n}@example.com`, externalId: `e-${n}`, emails: undefined }),
      );
    const all = await s.call('GET', '/Users');
    expect(all.body).toMatchObject({
      schemas: [SCIM_SCHEMAS.list],
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 3,
    });
    const one = await s.call('GET', '/Users', undefined, { filter: 'userName eq "B@example.com"' });
    expect(one.body).toMatchObject({ totalResults: 1 });
    const ext = await s.call('GET', '/Users', undefined, { filter: 'externalId eq "e-c"' });
    expect((ext.body as { Resources: { userName: string }[] }).Resources[0]?.userName).toBe(
      'c@example.com',
    );
    const page = await s.call('GET', '/Users', undefined, { startIndex: '2', count: '1' });
    expect(page.body).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });
    const none = await s.call('GET', '/Users', undefined, { count: '0' });
    expect(none.body).toMatchObject({ totalResults: 3, itemsPerPage: 0 });
    const bad = await s.call('GET', '/Users', undefined, { filter: 'userName gt "x"' });
    expect(bad).toMatchObject({ status: 400, body: { scimType: 'invalidFilter' } });
  });

  it('9.1 GET, 404 and unsupported methods', async () => {
    const id = ((await s.call('POST', '/Users', newUser())).body as { id: string }).id;
    expect((await s.call('GET', `/Users/${id}`)).status).toBe(200);
    expect((await s.call('GET', '/Users/missing')).body).toMatchObject({ status: '404' });
    expect((await s.call('PUT', '/Users')).status).toBe(405);
    expect((await s.call('POST', `/Users/${id}`, newUser())).status).toBe(405);
  });

  it('9.1 active:false via PATCH (Okta form) deactivates and calls the deactivation workflow', async () => {
    const id = ((await s.call('POST', '/Users', newUser())).body as { id: string }).id;
    const r = await s.call(
      'PATCH',
      `/Users/${id}`,
      patchBody({ op: 'replace', value: { active: false } }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: false });
    expect(s.deactivated).toEqual([id]);
    await s.call(
      'PATCH',
      `/Users/${id}`,
      patchBody({ op: 'replace', path: 'active', value: 'False' }),
    );
    expect(s.deactivated).toEqual([id]);
  });

  it('9.1 Entra-style PATCH replaces displayName and reactivates', async () => {
    const id = ((await s.call('POST', '/Users', newUser({ active: false }))).body as { id: string })
      .id;
    const r = await s.call(
      'PATCH',
      `/Users/${id}`,
      patchBody(
        { op: 'Replace', path: 'active', value: 'True' },
        { op: 'Replace', path: 'displayName', value: 'Ann Q' },
      ),
    );
    expect(r.body).toMatchObject({ active: true, displayName: 'Ann Q' });
    expect(s.deactivated).toEqual([]);
  });

  it('9.1 PUT replaces attributes and can deactivate; userName changes are checked for uniqueness', async () => {
    const id = ((await s.call('POST', '/Users', newUser())).body as { id: string }).id;
    await s.call('POST', '/Users', newUser({ userName: 'bob@example.com', emails: undefined }));
    const clash = await s.call(
      'PUT',
      `/Users/${id}`,
      newUser({ userName: 'bob@example.com', emails: undefined }),
    );
    expect(clash.status).toBe(409);
    const moved = await s.call(
      'PUT',
      `/Users/${id}`,
      newUser({
        userName: 'ann2@example.com',
        emails: undefined,
        externalId: 'ext-9',
        displayName: 'Ann Two',
      }),
    );
    expect(moved.body).toMatchObject({
      userName: 'ann2@example.com',
      externalId: 'ext-9',
      displayName: 'Ann Two',
    });
    const off = await s.call(
      'PUT',
      `/Users/${id}`,
      newUser({ userName: 'ann2@example.com', emails: undefined, active: false }),
    );
    expect(off.body).toMatchObject({ active: false });
    expect(s.deactivated).toContain(id);
  });

  it('9.1 DELETE deactivates (rows and logs are kept) and answers 204', async () => {
    const id = ((await s.call('POST', '/Users', newUser())).body as { id: string }).id;
    const r = await s.call('DELETE', `/Users/${id}`);
    expect(r.status).toBe(204);
    expect(s.deactivated).toEqual([id]);
    expect(s.store.users.has(id)).toBe(true);
  });

  it('9.1 unexpected failures become a generic SCIM 500 without leaking details', async () => {
    s.store.getUser = async () => {
      throw new Error('db password=hunter2');
    };
    const r = await s.call('GET', '/Users/x');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
  });
});

describe('9.1 SCIM server: Groups', () => {
  let s: ReturnType<typeof setup>;
  const mkUser = async (name: string) =>
    (
      (
        await s.call(
          'POST',
          '/Users',
          newUser({ userName: `${name}@example.com`, emails: undefined, externalId: name }),
        )
      ).body as { id: string }
    ).id;
  beforeEach(() => {
    s = setup();
  });

  it('9.1 group create makes a team with idp_group and SCIM membership (source scim)', async () => {
    const u1 = await mkUser('a');
    const r = await s.call('POST', '/Groups', {
      schemas: [SCIM_SCHEMAS.group],
      displayName: 'Engineering',
      members: [{ value: u1 }],
    });
    expect(r.status).toBe(201);
    const gid = (r.body as { id: string }).id;
    expect(r.headers.location).toContain(`/scim/v2/Groups/${gid}`);
    expect(r.body).toMatchObject({ displayName: 'Engineering', members: [{ value: u1 }] });
    expect(s.store.teams.get(gid)).toMatchObject({ slug: 'engineering', idpGroup: 'Engineering' });
    expect(s.store.memberships).toEqual([
      { teamId: gid, userId: u1, role: 'member', source: 'scim' },
    ]);
  });

  it('9.1 empty groups can be created; duplicates are 409; unknown members and bad names are 400', async () => {
    expect((await s.call('POST', '/Groups', { displayName: 'Empty' })).status).toBe(201);
    expect((await s.call('POST', '/Groups', { displayName: 'Empty' })).status).toBe(409);
    expect(
      (await s.call('POST', '/Groups', { displayName: 'G', members: [{ value: 'ghost' }] })).status,
    ).toBe(400);
    expect((await s.call('POST', '/Groups', { displayName: '???' })).status).toBe(400);
    expect((await s.call('POST', '/Groups', {})).status).toBe(400);
  });

  it('9.1 PATCH add/remove members (Okta and Entra shapes) maps to team membership', async () => {
    const [a, b, c] = [await mkUser('a'), await mkUser('b'), await mkUser('c')];
    const gid = ((await s.call('POST', '/Groups', { displayName: 'Ops' })).body as { id: string })
      .id;
    await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'add', path: 'members', value: [{ value: a }, { value: b }] }),
    );
    expect(s.store.memberships.map((m) => m.userId).sort()).toEqual([a, b].sort());
    await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'remove', path: `members[value eq "${a}"]` }),
    );
    await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'Add', path: 'members', value: [{ value: c }] }),
    );
    expect(s.store.memberships.map((m) => m.userId).sort()).toEqual([b, c].sort());
    const r = await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'Replace', path: 'members', value: [{ value: a }] }),
    );
    expect((r.body as { members: unknown[] }).members).toHaveLength(1);
    expect(s.store.memberships.map((m) => m.userId)).toEqual([a]);
    const renamed = await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'Replace', path: 'displayName', value: 'Platform' }),
    );
    expect(renamed.body).toMatchObject({ displayName: 'Platform' });
  });

  it('9.1 PUT replaces the member list', async () => {
    const [a, b] = [await mkUser('a'), await mkUser('b')];
    const gid = (
      (await s.call('POST', '/Groups', { displayName: 'Ops', members: [{ value: a }] })).body as {
        id: string;
      }
    ).id;
    await s.call('PUT', `/Groups/${gid}`, { displayName: 'Ops', members: [{ value: b }] });
    expect(s.store.memberships.map((m) => m.userId)).toEqual([b]);
  });

  it('9.1 manual memberships are never touched by SCIM', async () => {
    const a = await mkUser('a');
    const gid = ((await s.call('POST', '/Groups', { displayName: 'Ops' })).body as { id: string })
      .id;
    s.store.memberships.push({ teamId: gid, userId: a, role: 'manager', source: 'manual' });
    await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'add', path: 'members', value: [{ value: a }] }),
    );
    expect(s.store.memberships).toEqual([
      { teamId: gid, userId: a, role: 'manager', source: 'manual' },
    ]);
  });

  it('9.1 group mapping rules re-evaluate on SCIM updates: admin group grants and revokes the Admin role', async () => {
    s.store.rules = [
      {
        id: 'r',
        idpConnectionId: null,
        groupPattern: 'bastion-admins',
        mapsTo: { orgRole: 'admin' },
        priority: 1,
      },
    ];
    const a = await mkUser('a');
    const gid = (
      (await s.call('POST', '/Groups', { displayName: 'bastion-admins', members: [{ value: a }] }))
        .body as { id: string }
    ).id;
    expect(s.store.users.get(a)?.orgRole).toBe('admin');
    expect(s.store.events).toContain('user.role_changed');
    await s.call(
      'PATCH',
      `/Groups/${gid}`,
      patchBody({ op: 'remove', path: 'members', value: [{ value: a }] }),
    );
    expect(s.store.users.get(a)?.orgRole).toBe('member');
  });

  it('9.1 explicit team mapping rules add manager memberships for SCIM groups', async () => {
    s.store.rules = [
      {
        id: 'r',
        idpConnectionId: null,
        groupPattern: 'leads',
        mapsTo: { teamId: 'team-x', teamRole: 'manager' },
        priority: 1,
      },
    ];
    const a = await mkUser('a');
    await s.call('POST', '/Groups', { displayName: 'leads', members: [{ value: a }] });
    expect(s.store.memberships).toContainEqual({
      teamId: 'team-x',
      userId: a,
      role: 'manager',
      source: 'scim',
    });
  });

  it('9.1 GET list and 404; DELETE removes SCIM memberships and detaches the group, keeping the team', async () => {
    const a = await mkUser('a');
    const gid = (
      (await s.call('POST', '/Groups', { displayName: 'Ops', members: [{ value: a }] })).body as {
        id: string;
      }
    ).id;
    const list = await s.call('GET', '/Groups', undefined, { filter: 'displayName eq "ops"' });
    expect(list.body).toMatchObject({ totalResults: 1 });
    expect((await s.call('GET', '/Groups/none')).status).toBe(404);
    expect((await s.call('PUT', '/Groups')).status).toBe(405);
    expect((await s.call('POST', `/Groups/${gid}`)).status).toBe(405);
    expect((await s.call('DELETE', `/Groups/${gid}`)).status).toBe(204);
    expect(s.store.memberships).toEqual([]);
    expect(s.store.teams.has(gid)).toBe(true);
    expect((await s.call('GET', `/Groups/${gid}`)).status).toBe(404);
  });

  it('9.1 a team slug conflict reported by the store becomes 409', async () => {
    s.store.teams.set('t', {
      id: 't',
      slug: 'ops',
      displayName: 'ops',
      idpGroup: null,
      createdAt: new Date(),
    });
    expect((await s.call('POST', '/Groups', { displayName: 'Ops' })).status).toBe(409);
  });
});

describe('9.1 SCIM server: logging', () => {
  it('9.1 an unexpected failure is logged through the logger port, never returned', async () => {
    const store = new MemoryScimStore();
    store.getUser = async () => {
      throw new Error('db password=hunter2');
    };
    const logged: { message: string; error: unknown }[] = [];
    const svc = new ScimService({
      store,
      tokens: { findByHash: async () => ({ id: 't', expiresAt: null, revokedAt: null }) },
      deactivator: { deactivate: async () => {} },
      baseUrl: 'https://bastion.test',
      logger: { error: (message, fields) => logged.push({ message, error: fields?.error }) },
    });
    const r = await svc.handle({
      method: 'GET',
      path: '/Users/x',
      query: {},
      headers: { authorization: 'Bearer anything' },
      body: undefined,
    });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.error)).toContain('hunter2');
  });
});
