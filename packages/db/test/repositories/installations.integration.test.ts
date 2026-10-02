import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { getConfigVersion } from '../../src/config-version';
import {
  createAutoInstallRepository,
  createCatalogEntryRepository,
  createCatalogVersionRepository,
  createEndpointRepository,
  createInstallationRegistry,
  createInstallationRepository,
  createRouterRepository,
  createTeamRepository,
  createUpstreamTokenStore,
  createUserRepository,
  toEndpointDefinition,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const audit = { actorType: 'user', actorId: newId() } as const;
const spec = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://x.example/mcp',
  auth: { mode: 'oauth', client: { registration: 'dcr' } },
};
const plainSpec = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://y.example/mcp',
  auth: { mode: 'none' },
};

describe.skipIf(!dbEnabled())('11.4 installations, endpoints, auto-install, router mapping', () => {
  const h = useTestDb();
  const author = newId();

  const seed = async () => {
    const users = createUserRepository(h.db.prisma);
    const teams = createTeamRepository(h.db.prisma);
    const user = await users.create({ email: `u${newId()}@acme.com`, displayName: 'U' });
    const team = await teams.create({ slug: `t${newId().slice(-8)}`, displayName: 'T' });
    await teams.setMembership({ teamId: team.id, userId: user.id, role: 'member' });
    const entries = createCatalogEntryRepository(h.db.prisma);
    const entry = await entries.create({
      slug: `e${newId().slice(-8)}`,
      displayName: 'E',
      description: 'd',
      createdBy: author,
    });
    const versions = createCatalogVersionRepository(h.db.prisma);
    const v = await versions.create({
      entryId: entry.id,
      label: '1.0.0',
      serverSpec: spec,
      installForm: {},
      overrides: { tools: { rename: 1 } },
      createdBy: author,
    });
    await versions.publish(v.id);
    return { user, team, entry, version: v };
  };

  it('11.4 creates catalog and personal installations; enforces XOR, slug rules and owner uniqueness', async () => {
    const { user, entry, version } = await seed();
    const repo = createInstallationRepository(h.db.prisma);
    const i = await repo.create(
      {
        ownerType: 'user',
        ownerId: user.id,
        catalogEntryId: entry.id,
        catalogVersionId: version.id,
        slug: 'pg-main',
        displayName: 'PG',
        variables: { host: 'db' },
      },
      audit,
    );
    expect(i).toMatchObject({
      toolPrefix: 'pg_main',
      status: 'ready',
      origin: 'manual',
      variables: { host: 'db' },
    });
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        catalogEntryId: entry.id,
        slug: 'pg-main',
        displayName: 'dup',
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        slug: 'BAD SLUG',
        displayName: 'x',
        catalogEntryId: entry.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      repo.create({ ownerType: 'user', ownerId: user.id, slug: 'none', displayName: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        slug: 'both',
        displayName: 'x',
        catalogEntryId: entry.id,
        personalSpec: plainSpec,
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    const personal = await repo.create({
      ownerType: 'user',
      ownerId: user.id,
      slug: 'mine',
      displayName: 'Mine',
      personalSpec: plainSpec,
      toolPrefix: 'mine_x',
    });
    expect(personal.personalSpec).toMatchObject({ type: 'remote' });
    expect(personal.toolPrefix).toBe('mine_x');
    expect(await repo.getByOwnerSlug('user', user.id, 'mine')).toMatchObject({ id: personal.id });
    expect(await repo.get(newId())).toBeNull();
    expect(await getConfigVersion(h.db.prisma, 'installation', i.id)).toBe(1n);
    expect(await getConfigVersion(h.db.prisma, 'user', user.id)).toBeGreaterThanOrEqual(2n);
    const listed = await repo.list({ ownerType: 'user', ownerId: user.id, limit: 1 });
    expect(listed.items).toHaveLength(1);
    const more = await repo.list({
      ownerType: 'user',
      ownerId: user.id,
      limit: 1,
      cursor: listed.nextCursor ?? undefined,
    });
    expect(more.items).toHaveLength(1);
    expect(
      (
        await repo.list({
          ownerId: user.id,
          catalogEntryId: entry.id,
          status: 'ready',
          enabled: true,
        })
      ).items,
    ).toHaveLength(1);
  });

  it('17.1 updates and deletes need the current ETag and bump installation and owner versions', async () => {
    const { user, entry } = await seed();
    const repo = createInstallationRepository(h.db.prisma);
    const i = await repo.create({
      ownerType: 'user',
      ownerId: user.id,
      catalogEntryId: entry.id,
      slug: 'etag',
      displayName: 'E',
    });
    const etag = (await repo.getWithEtag(i.id))?.etag ?? '';
    const before = await getConfigVersion(h.db.prisma, 'user', user.id);
    const upd = await repo.update(
      i.id,
      {
        enabled: false,
        variables: { a: 1 },
        secretRefs: { k: 'id' },
        overrides: { x: 1 },
        statusDetail: { why: 'test' },
        status: 'needs_setup',
      },
      { ifMatch: etag, audit },
    );
    expect(upd).toMatchObject({
      enabled: false,
      status: 'needs_setup',
      statusDetail: { why: 'test' },
    });
    expect(await getConfigVersion(h.db.prisma, 'user', user.id)).toBe(before + 1n);
    await expect(repo.update(i.id, { enabled: true }, { ifMatch: etag })).rejects.toMatchObject({
      httpStatus: 412,
    });
    await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    await repo.update(i.id, { statusDetail: null }, { ifMatch: '*' });
    await repo.delete(i.id, { ifMatch: '*', audit });
    expect(await repo.get(i.id)).toBeNull();
    await expect(repo.delete(i.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('18 status sink marks and clears errors for the UI', async () => {
    const { user, entry } = await seed();
    const repo = createInstallationRepository(h.db.prisma);
    const i = await repo.create({
      ownerType: 'user',
      ownerId: user.id,
      catalogEntryId: entry.id,
      slug: 'sink',
      displayName: 'S',
    });
    await repo.markError(i.id, { phase: 'install', message: 'boom', stderrTail: ['x'] });
    expect(await repo.get(i.id)).toMatchObject({
      status: 'error',
      statusDetail: { phase: 'install' },
    });
    await repo.clearError(i.id);
    expect(await repo.get(i.id)).toMatchObject({ status: 'ready', statusDetail: null });
    await repo.clearError(i.id);
    await repo.markError(newId(), { phase: 'x', message: 'y', stderrTail: [] });
    await repo.clearError(newId());
  });

  it('11.4 users hide team installations for themselves; listForPrincipal maps InstallationInfo', async () => {
    const { user, team, entry, version } = await seed();
    const repo = createInstallationRepository(h.db.prisma);
    const own = await repo.create({
      ownerType: 'user',
      ownerId: user.id,
      catalogEntryId: entry.id,
      catalogVersionId: version.id,
      slug: 'own',
      displayName: 'Own',
      overrides: { tools: { a: 1 } },
    });
    const shared = await repo.create({
      ownerType: 'team',
      ownerId: team.id,
      catalogEntryId: entry.id,
      catalogVersionId: version.id,
      pinnedVersion: true,
      slug: 'shared',
      displayName: 'Shared',
    });
    const personal = await repo.create({
      ownerType: 'user',
      ownerId: user.id,
      personalSpec: plainSpec,
      slug: 'personal',
      displayName: 'Personal',
    });
    const router = createRouterRepository(h.db.prisma);
    const principal = { id: user.id, type: 'user' as const, teamIds: [team.id] };
    const infos = await router.listForPrincipal(principal);
    expect(infos.map((x) => x.id)).toEqual([...[own.id, personal.id].sort(), shared.id]);
    const mapped = infos.find((x) => x.id === own.id);
    expect(mapped).toMatchObject({
      catalogSlug: entry.slug,
      catalogVersionId: version.id,
      needsAuth: true,
      pinned: false,
      owner: { kind: 'user', id: user.id },
      layers: { catalog: { tools: { rename: 1 } }, installation: { tools: { a: 1 } } },
      capabilities: { tools: true },
      policy: {
        ownerUserId: user.id,
        catalogEntry: { risk: 'medium', visibility: { org: false } },
      },
    });
    const teamInfo = infos.find((x) => x.id === shared.id);
    expect(teamInfo?.owner).toMatchObject({ kind: 'team', id: team.id, slug: team.slug });
    expect(teamInfo?.pinned).toBe(true);
    const personalInfo = infos.find((x) => x.id === personal.id);
    expect(personalInfo).toMatchObject({ catalogEntryId: personal.id, needsAuth: false });
    expect(personalInfo?.catalogSlug).toBeUndefined();

    // a valid OAuth token clears needsAuth; the newest snapshot drives capabilities
    await createUpstreamTokenStore(h.db.prisma).put({
      principalType: 'user',
      principalId: user.id,
      installationId: own.id,
      issuer: 'https://as',
      secretId: newId(),
      scopes: [],
      expiresAt: null,
      status: 'valid',
      updatedAt: new Date(),
    });
    await h.db.prisma.upstreamSnapshot.create({
      data: {
        id: newId(),
        installationId: own.id,
        configHash: new Uint8Array(32),
        tools: [],
        prompts: [{ name: 'p' }],
        resources: [],
        resourceTemplates: [],
      },
    });
    const again = (await router.getInfo(own.id, principal)) ?? undefined;
    expect(again).toMatchObject({
      needsAuth: false,
      capabilities: { tools: false, prompts: true, resources: false },
    });
    expect(await router.getInfo(newId(), principal)).toBeNull();
    expect(
      (await router.listForCatalogSlug(principal, entry.slug)).map((x) => x.id).sort(),
    ).toEqual([own.id, shared.id].sort());

    await repo.setHidden(shared.id, user.id, true, audit);
    expect(await repo.listHidden(user.id)).toEqual([shared.id]);
    expect((await router.listForPrincipal(principal)).map((x) => x.id)).not.toContain(shared.id);
    expect(
      (await router.listForPrincipal(principal, { includeHidden: true })).map((x) => x.id),
    ).toContain(shared.id);
    await repo.setHidden(shared.id, user.id, false);
    expect((await router.listForPrincipal(principal)).map((x) => x.id)).toContain(shared.id);
    await expect(repo.setHidden(newId(), user.id, true)).rejects.toMatchObject({ httpStatus: 404 });

    // service principals see their own and their team's installations
    const sa = newId();
    await h.db.prisma.serviceAccount.create({
      data: { id: sa, teamId: team.id, slug: `sa-${sa.slice(-6)}`, displayName: 'SA' },
    });
    const svcInstall = await repo.create({
      ownerType: 'service',
      ownerId: sa,
      catalogEntryId: entry.id,
      slug: 'svc',
      displayName: 'Svc',
    });
    const svcInfos = await router.listForPrincipal({ id: sa, type: 'service', teamIds: [team.id] });
    expect(svcInfos.find((x) => x.id === svcInstall.id)?.owner).toEqual({
      kind: 'service',
      id: sa,
      teamId: team.id,
    });
    expect(svcInfos.map((x) => x.id)).toContain(shared.id);
  });

  it('7.1 endpoints: ordered installation ids, validated references, ETag, router definition', async () => {
    const { user, entry } = await seed();
    const installs = createInstallationRepository(h.db.prisma);
    const a = await installs.create({
      ownerType: 'user',
      ownerId: user.id,
      catalogEntryId: entry.id,
      slug: 'ea',
      displayName: 'A',
    });
    const b = await installs.create({
      ownerType: 'user',
      ownerId: user.id,
      personalSpec: plainSpec,
      slug: 'eb',
      displayName: 'B',
    });
    const repo = createEndpointRepository(h.db.prisma);
    const e = await repo.create(
      {
        ownerType: 'user',
        ownerId: user.id,
        slug: 'work',
        displayName: 'Work',
        installationIds: [b.id, a.id],
        instructions: 'Be careful',
      },
      audit,
    );
    expect(e.installationIds).toEqual([b.id, a.id]);
    expect(await repo.findDefinition(e.id)).toEqual({
      id: e.id,
      kind: 'named',
      slug: 'work',
      installationIds: [b.id, a.id],
      prefixMode: 'always',
      instructions: 'Be careful',
    });
    expect(toEndpointDefinition({ ...e, instructions: null })).not.toHaveProperty('instructions');
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        slug: 'work',
        displayName: 'dup',
        installationIds: [],
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        slug: 'ghost',
        displayName: 'g',
        installationIds: [newId()],
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        slug: 'twice',
        displayName: 'g',
        installationIds: [a.id, a.id],
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      repo.create({
        ownerType: 'user',
        ownerId: user.id,
        slug: 'Bad_Slug',
        displayName: 'g',
        installationIds: [],
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    expect((await repo.getBySlug('user', user.id, 'work'))?.id).toBe(e.id);
    expect((await repo.listForOwner('user', user.id)).map((x) => x.slug)).toEqual(['work']);
    const etag = (await repo.getWithEtag(e.id))?.etag ?? '';
    const upd = await repo.update(
      e.id,
      { installationIds: [a.id], prefixMode: 'onCollision' },
      { ifMatch: etag, audit },
    );
    expect(upd).toMatchObject({ installationIds: [a.id], prefixMode: 'onCollision' });
    await expect(
      repo.update(e.id, { displayName: 'late' }, { ifMatch: etag }),
    ).rejects.toMatchObject({ httpStatus: 412 });
    await expect(
      repo.update(e.id, { installationIds: [newId()] }, { ifMatch: '*' }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(await getConfigVersion(h.db.prisma, 'endpoint', e.id)).toBe(2n);
    await repo.delete(e.id, { ifMatch: '*', audit });
    expect(await repo.get(e.id)).toBeNull();
    expect(await repo.findDefinition(e.id)).toBeNull();
    await expect(repo.delete(e.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
    expect(await repo.getWithEtag(e.id)).toBeNull();
  });

  it('6.4 installation registry resolves spec, variables, runtime flags and follows the current version', async () => {
    const { user, entry, version } = await seed();
    const versions = createCatalogVersionRepository(h.db.prisma);
    await versions.update(version.id, {}).catch(() => undefined);
    const installs = createInstallationRepository(h.db.prisma);
    const i = await installs.create({
      ownerType: 'user',
      ownerId: user.id,
      catalogEntryId: entry.id,
      catalogVersionId: version.id,
      slug: 'reg',
      displayName: 'R',
      variables: { n: 5 },
    });
    const registry = createInstallationRegistry(h.db.prisma, {
      configHash: (x) => `hash:${x.catalogVersionId}:${JSON.stringify(x.variables)}`,
    });
    const resolved = await registry.get(i.id);
    expect(resolved).toMatchObject({
      installationId: i.id,
      catalogEntryName: entry.slug,
      origin: 'admin',
      ownerUserId: user.id,
      variables: { n: '5' },
      replicas: 1,
      roots: [],
      enableSampling: false,
    });
    expect(resolved?.configHash).toBe(`hash:${version.id}:{"n":"5"}`);

    // publishing a newer version moves a follow-current installation, not a pinned one
    const v2 = await versions.create({
      entryId: entry.id,
      label: '2.0.0',
      serverSpec: plainSpec,
      installForm: {},
      runtime: { enableRoots: true, replicas: 2, extensions: { block: ['x'] }, listTtlMs: 5000 },
      createdBy: author,
    });
    await versions.publish(v2.id);
    const moved = await registry.get(i.id);
    expect(moved).toMatchObject({
      catalogVersionId: v2.id,
      enableRoots: true,
      replicas: 2,
      extensions: { block: ['x'] },
      listTtlMs: 5000,
    });
    await installs.update(i.id, { pinnedVersion: true }, { ifMatch: '*' });
    expect((await registry.get(i.id))?.catalogVersionId).toBe(version.id);

    const pkg = await installs.create({
      ownerType: 'user',
      ownerId: user.id,
      slug: 'pkg',
      displayName: 'P',
      personalSpec: {
        type: 'package',
        runtime: 'npm',
        identifier: 'x',
        version: '1.0.0',
        auth: { mode: 'none' },
      },
    });
    expect(await registry.get(pkg.id)).toMatchObject({
      origin: 'personal',
      catalogEntryName: 'personal',
      roots: ['file:///workspace'],
    });
    expect(await registry.get(newId())).toBeNull();
  });

  describe('11.5 auto-install policies', () => {
    it('validates the target and the entry state, versions with ETag, and keeps a ledger', async () => {
      const { user, team, entry } = await seed();
      const repo = createAutoInstallRepository(h.db.prisma);
      const draft = await createCatalogEntryRepository(h.db.prisma).create({
        slug: `d${newId().slice(-8)}`,
        displayName: 'D',
        description: 'd',
        createdBy: author,
      });
      await expect(
        repo.create({
          catalogEntryId: draft.id,
          target: { all: true },
          mode: 'default',
          createdBy: author,
        }),
      ).rejects.toMatchObject({ httpStatus: 422 });
      await expect(
        repo.create({
          catalogEntryId: newId(),
          target: { all: true },
          mode: 'default',
          createdBy: author,
        }),
      ).rejects.toMatchObject({ httpStatus: 404 });
      await expect(
        repo.create({
          catalogEntryId: entry.id,
          target: { orgRoles: ['root' as never] },
          mode: 'default',
          createdBy: author,
        }),
      ).rejects.toThrow();
      const p = await repo.create(
        {
          catalogEntryId: entry.id,
          target: { teamIds: [team.id] },
          mode: 'required',
          createdBy: author,
        },
        audit,
      );
      expect(p).toMatchObject({ scope: 'user', applyToExisting: true, enabled: true });
      expect(
        (await repo.list({ catalogEntryId: entry.id, enabled: true })).map((x) => x.id),
      ).toContain(p.id);
      expect((await repo.listEnabledForUserScope()).map((x) => x.id)).toContain(p.id);
      const etag = (await repo.getWithEtag(p.id))?.etag ?? '';
      const upd = await repo.update(
        p.id,
        { mode: 'default', target: { all: true }, enabled: false },
        { ifMatch: etag, audit },
      );
      expect(upd).toMatchObject({ mode: 'default', enabled: false, target: { all: true } });
      await expect(repo.update(p.id, { enabled: true }, { ifMatch: etag })).rejects.toMatchObject({
        httpStatus: 412,
      });
      await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect((await repo.listEnabledForUserScope()).map((x) => x.id)).not.toContain(p.id);

      // target users: union of team, role and idp group, by id order, only unapplied
      await repo.update(
        p.id,
        { target: { teamIds: [team.id], orgRoles: ['auditor'] }, enabled: true },
        { ifMatch: '*' },
      );
      const auditor = await createUserRepository(h.db.prisma).create({
        email: `aud${newId()}@acme.com`,
        displayName: 'A',
        orgRole: 'auditor',
      });
      const targets = await repo.listTargetUsers(p.id, { limit: 10 });
      expect(targets).toEqual(expect.arrayContaining([user.id, auditor.id]));
      expect([...targets].sort()).toEqual(targets);
      const firstOnly = await repo.listTargetUsers(p.id, { limit: 1 });
      expect(firstOnly).toHaveLength(1);
      const afterFirst = await repo.listTargetUsers(p.id, { limit: 1, afterId: firstOnly[0] });
      expect(afterFirst[0]).not.toBe(firstOnly[0]);
      expect(await repo.listTargetTeams(p.id)).toEqual([team.id]);
      await expect(repo.listTargetUsers(newId(), { limit: 1 })).rejects.toMatchObject({
        httpStatus: 404,
      });
      await expect(repo.listTargetTeams(newId())).rejects.toMatchObject({ httpStatus: 404 });
      await repo.update(p.id, { target: { idpGroups: ['eng'] } }, { ifMatch: '*' });
      expect(await repo.listTargetUsers(p.id, { limit: 5 })).toEqual([]);
      await repo.update(p.id, { target: {} }, { ifMatch: '*' });
      expect(await repo.listTargetUsers(p.id, { limit: 5 })).toEqual([]);

      await repo.delete(p.id, { ifMatch: '*', audit });
      expect(await repo.get(p.id)).toBeNull();
      await expect(repo.delete(p.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('applies once per (policy, subject): repeats and concurrent triggers do nothing; created installations see the same transaction', async () => {
      const { user, entry, version } = await seed();
      const policies = createAutoInstallRepository(h.db.prisma);
      const p = await policies.create({
        catalogEntryId: entry.id,
        target: { all: true },
        mode: 'default',
        createdBy: author,
      });
      const installs = createInstallationRepository(h.db.prisma);
      let runs = 0;
      const key = { policyId: p.id, subjectType: 'user' as const, subjectId: user.id };
      const run = async (c: Parameters<Parameters<typeof policies.applyOnce>[1]>[0]) => {
        runs += 1;
        const inst = await createInstallationRepository(c).create({
          ownerType: 'user',
          ownerId: user.id,
          catalogEntryId: entry.id,
          catalogVersionId: version.id,
          slug: 'auto',
          displayName: 'Auto',
          origin: `autoInstall:${p.id}`,
          status: 'needs_setup',
        });
        return { installationId: inst.id, result: 'installed' };
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () => policies.applyOnce(key, run).catch((e) => e)),
      );
      expect(runs).toBe(1);
      expect(results.filter((r) => r.applied === true)).toHaveLength(1);
      for (const r of results) expect(r).toMatchObject({ result: 'installed' });
      const again = await policies.applyOnce(key, run);
      expect(again).toMatchObject({ applied: false, result: 'installed' });
      expect(
        (await policies.listApplications(p.id, { subjectType: 'user' })).map((a) => a.subjectId),
      ).toEqual([user.id]);
      expect(await policies.listApplications(p.id, { subjectType: 'team' })).toEqual([]);
      expect(
        await policies.listTargetUsers(p.id, { limit: 100, onlyUnapplied: true }),
      ).not.toContain(user.id);

      // the user removes the `default` installation; it is not re-added
      const inst = await installs.getByOwnerSlug('user', user.id, 'auto');
      await installs.delete(inst?.id ?? '', { ifMatch: '*' });
      expect((await policies.applyOnce(key, run)).applied).toBe(false);
      expect(runs).toBe(1);

      // a failing run rolls the ledger row back so the trigger can retry
      const retryKey = { ...key, subjectId: newId() };
      await expect(
        policies.applyOnce(retryKey, () => Promise.reject(new Error('nope'))),
      ).rejects.toThrow('nope');
      expect(await policies.listApplications(p.id)).toHaveLength(1);
    });

    it('required policies pin their installations: no hide, no delete; removing the policy releases them', async () => {
      const { user, entry, version } = await seed();
      const policies = createAutoInstallRepository(h.db.prisma);
      const installs = createInstallationRepository(h.db.prisma);
      const p = await policies.create({
        catalogEntryId: entry.id,
        target: { all: true },
        mode: 'required',
        createdBy: author,
      });
      const inst = await installs.create({
        ownerType: 'user',
        ownerId: user.id,
        catalogEntryId: entry.id,
        catalogVersionId: version.id,
        slug: 'req',
        displayName: 'R',
        origin: `autoInstall:${p.id}`,
      });
      await expect(installs.setHidden(inst.id, user.id, true)).rejects.toMatchObject({
        httpStatus: 409,
      });
      await expect(installs.delete(inst.id, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 409,
      });
      await policies.delete(p.id, { ifMatch: '*' });
      await installs.setHidden(inst.id, user.id, true);
      await installs.delete(inst.id, { ifMatch: '*' });
      expect(await installs.get(inst.id)).toBeNull();
    });
  });
});
