import { createHash } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { getConfigVersion } from '../../src/config-version';
import {
  createCatalogEntryRepository,
  createCatalogVersionRepository,
  createCustomPolicyRepository,
  createDefinitionPinRepository,
  createDriftReviewRepository,
  createGuardProfileRepository,
  createInstallationRepository,
  createLimitRuleRepository,
  createOrgSettingsRepository,
  createPolicyDataSource,
  createPolicyRuleRepository,
  createTeamRepository,
  createUserRepository,
  toPipelineProfile,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const audit = { actorType: 'user', actorId: newId() } as const;
const author = newId();
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const spec = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://x.example/mcp',
  auth: { mode: 'none' },
};

describe.skipIf(!dbEnabled())(
  '10, 13, 14 policy rules, custom policies, limits, guards, pins and drift',
  () => {
    const h = useTestDb();

    it('10.3 policy rules: CRUD with ETag, org version bump, priority ordering in the data source', async () => {
      const repo = createPolicyRuleRepository(h.db.prisma);
      const before = await getConfigVersion(h.db.prisma, 'org');
      const a = await repo.create(
        {
          name: 'deny destructive',
          effect: 'forbid',
          who: { role: 'member' },
          what: { annotations: { destructive: true } },
          priority: 50,
          createdBy: author,
        },
        audit,
      );
      const b = await repo.create({
        name: 'allow all',
        effect: 'permit',
        who: {},
        what: {},
        priority: 10,
        createdBy: author,
      });
      const off = await repo.create({
        name: 'disabled',
        effect: 'permit',
        who: {},
        what: {},
        enabled: false,
        createdBy: author,
      });
      await expect(
        repo.create({ name: 'x', effect: 'maybe' as never, who: {}, what: {}, createdBy: author }),
      ).rejects.toThrow();
      expect(await getConfigVersion(h.db.prisma, 'org')).toBe(before + 3n);
      const etag = (await repo.getWithEtag(a.id))?.etag ?? '';
      const upd = await repo.update(
        a.id,
        {
          who: { role: 'auditor' },
          what: { toolName: 'x*' },
          when: { hours: { from: 9, to: 17 } },
          name: 'renamed',
        },
        { ifMatch: etag, audit },
      );
      expect(upd).toMatchObject({ name: 'renamed', when: { hours: { from: 9, to: 17 } } });
      await expect(repo.update(a.id, { enabled: false }, { ifMatch: etag })).rejects.toMatchObject({
        httpStatus: 412,
      });
      await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect((await repo.list({ enabled: true })).items.map((r) => r.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      const page = await repo.list({ limit: 2 });
      expect(
        (await repo.list({ limit: 2, cursor: page.nextCursor ?? undefined })).items,
      ).toHaveLength(1);
      expect((await repo.list({ ownerTeamId: newId() })).items).toEqual([]);

      const data = await createPolicyDataSource(h.db.prisma).load();
      expect(data.rules.map((r) => r.id)).toEqual([b.id, a.id]);
      expect(data.rules.find((r) => r.id === off.id)).toBeUndefined();
      await repo.delete(off.id, { ifMatch: '*', audit });
      await expect(repo.delete(off.id, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect(await repo.get(off.id)).toBeNull();
    });

    it('10.4 custom policies: unique names, tests kept, disabled ones left out of the data source', async () => {
      const repo = createCustomPolicyRepository(h.db.prisma);
      const p = await repo.create(
        {
          name: 'no-writes-friday',
          cedar: 'forbid (principal, action, resource);',
          tests: [{ name: 't1' }],
          createdBy: author,
        },
        audit,
      );
      await expect(
        repo.create({ name: 'no-writes-friday', cedar: 'x', createdBy: author }),
      ).rejects.toMatchObject({ httpStatus: 409 });
      const off = await repo.create({
        name: 'off',
        cedar: 'permit (principal, action, resource);',
        enabled: false,
        createdBy: author,
      });
      const etag = (await repo.getWithEtag(p.id))?.etag ?? '';
      const upd = await repo.update(
        p.id,
        { cedar: 'forbid (principal, action, resource) when { true };', tests: [] },
        { ifMatch: etag, audit },
      );
      expect(upd.tests).toEqual([]);
      await expect(repo.update(p.id, { name: 'late' }, { ifMatch: etag })).rejects.toMatchObject({
        httpStatus: 412,
      });
      await expect(
        repo.update(off.id, { name: 'no-writes-friday' }, { ifMatch: '*' }),
      ).rejects.toMatchObject({ httpStatus: 409 });
      await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect((await repo.list()).map((x) => x.name)).toEqual(['no-writes-friday', 'off']);
      const data = await createPolicyDataSource(h.db.prisma).load();
      expect(data.customPolicies).toEqual([{ id: p.id, cedar: upd.cedar }]);
      expect(await repo.get(off.id)).toMatchObject({ enabled: false });
      await repo.delete(off.id, { ifMatch: '*', audit });
      await expect(repo.delete(off.id, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
    });

    it('10.3 the policy data source assembles teams, entries, installations, publishers and settings', async () => {
      const users = createUserRepository(h.db.prisma);
      const teams = createTeamRepository(h.db.prisma);
      const u = await users.create({
        email: 'pub@acme.com',
        displayName: 'P',
        catalogPublishOrgWide: true,
      });
      await users.create({
        email: 'gone@acme.com',
        displayName: 'G',
        catalogPublishOrgWide: true,
        status: 'deactivated',
      });
      const t = await teams.create({ slug: 'data-team', displayName: 'D' });
      const entry = await createCatalogEntryRepository(h.db.prisma).create({
        slug: 'data-entry',
        displayName: 'E',
        description: 'e',
        ownerTeamId: t.id,
        risk: 'high',
        visibility: { org: true },
        createdBy: author,
      });
      const installs = createInstallationRepository(h.db.prisma);
      const own = await installs.create({
        ownerType: 'user',
        ownerId: u.id,
        catalogEntryId: entry.id,
        slug: 'own',
        displayName: 'Own',
      });
      const team = await installs.create({
        ownerType: 'team',
        ownerId: t.id,
        catalogEntryId: entry.id,
        slug: 'team',
        displayName: 'Team',
      });
      const personal = await installs.create({
        ownerType: 'user',
        ownerId: u.id,
        personalSpec: spec,
        slug: 'pers',
        displayName: 'P',
      });
      const sa = newId();
      await h.db.prisma.serviceAccount.create({
        data: { id: sa, teamId: t.id, slug: 'bot-sa', displayName: 'Bot' },
      });
      const svc = await installs.create({
        ownerType: 'service',
        ownerId: sa,
        catalogEntryId: entry.id,
        slug: 'svc',
        displayName: 'S',
      });
      await createOrgSettingsRepository(h.db.prisma).set('logs', {
        retentionDays: 30,
        capturePreviews: false,
        managerVisibility: false,
      });
      const data = await createPolicyDataSource(h.db.prisma).load(new AbortController().signal);
      expect(data.settings).toEqual({ logsManagerVisibility: false });
      expect(data.orgWidePublisherIds).toEqual([u.id]);
      expect(data.teams).toContainEqual({ id: t.id, slug: 'data-team' });
      expect(data.catalogEntries).toContainEqual({
        id: entry.id,
        ownerTeamId: t.id,
        visibility: { org: true, teamIds: [], userIds: [] },
        risk: 'high',
      });
      const byId = new Map(data.installations.map((i) => [i.id, i]));
      expect(byId.get(own.id)).toMatchObject({
        catalogEntryId: entry.id,
        ownerUserId: u.id,
        catalogEntry: { risk: 'high' },
      });
      expect(byId.get(team.id)).toMatchObject({ ownerTeamId: t.id });
      expect(byId.get(personal.id)).toEqual({
        id: personal.id,
        catalogEntryId: personal.id,
        ownerUserId: u.id,
      });
      expect(byId.get(svc.id)).toMatchObject({ ownerServiceId: sa, ownerServiceTeamId: t.id });
      const aborted = new AbortController();
      aborted.abort();
      await expect(createPolicyDataSource(h.db.prisma).load(aborted.signal)).rejects.toThrow();
    });

    it('14.1 limit rules: params validated per kind, scope and subject match, ETag, org bump', async () => {
      const repo = createLimitRuleRepository(h.db.prisma);
      const rate = await repo.create(
        {
          name: 'burst',
          subject: 'user',
          kind: 'rate',
          params: { points: 10, perSeconds: 60, burst: 5 },
          scope: { tool: 'pg__*' },
        },
        audit,
      );
      const quota = await repo.create({
        name: 'daily',
        subject: 'team',
        subjectMatch: ['t1'],
        kind: 'quota',
        params: { points: 100, period: 'day' },
        metric: 'bytesOut',
        cost: { expensive: 5 },
        action: 'warn',
        enabled: false,
      });
      const conc = await repo.create({
        name: 'conc',
        subject: 'org',
        kind: 'concurrency',
        params: { max: 4 },
      });
      expect(conc.params).toEqual({ max: 4, leaseSeconds: 900 });
      expect(rate).toMatchObject({
        subjectMatch: 'each',
        metric: 'calls',
        action: 'reject',
        cost: null,
      });
      await expect(
        repo.create({ name: 'bad', subject: 'user', kind: 'rate', params: { points: 0 } }),
      ).rejects.toThrow();
      await expect(
        repo.create({
          name: 'bad',
          subject: 'nobody' as never,
          kind: 'rate',
          params: { points: 1, perSeconds: 1, burst: 0 },
        }),
      ).rejects.toThrow();
      expect(quota).toMatchObject({ subjectMatch: ['t1'], cost: { expensive: 5 }, enabled: false });
      const etag = (await repo.getWithEtag(rate.id))?.etag ?? '';
      const upd = await repo.update(
        rate.id,
        {
          params: { points: 20, perSeconds: 60, burst: 0 },
          scope: {},
          subjectMatch: 'each',
          cost: null,
          name: 'burst2',
        },
        { ifMatch: etag, audit },
      );
      expect(upd.params).toMatchObject({ points: 20 });
      await expect(
        repo.update(rate.id, { params: { nonsense: 1 } }, { ifMatch: '*' }),
      ).rejects.toThrow();
      await expect(repo.update(rate.id, { name: 'late' }, { ifMatch: etag })).rejects.toMatchObject(
        { httpStatus: 412 },
      );
      await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect((await repo.list({ enabled: true })).map((r) => r.name).sort()).toEqual([
        'burst2',
        'conc',
      ]);
      expect(await repo.list({ ownerTeamId: newId() })).toEqual([]);
      await repo.delete(quota.id, { ifMatch: '*', audit });
      await expect(repo.delete(quota.id, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect(await repo.get(quota.id)).toBeNull();
    });

    it('13.1 guard profiles: CRUD, a single org default mirrored into settings, pipeline mapping, delete guards', async () => {
      const repo = createGuardProfileRepository(h.db.prisma);
      const a = await repo.create(
        {
          name: 'strict',
          guards: [{ instanceId: 'g1', type: 'pii', config: {} }],
          settings: { onDrift: 'block', maxScanBytes: 1024 },
        },
        audit,
      );
      const b = await repo.create({ name: 'lenient', guards: [], latencyBudgetMs: 800 });
      await expect(repo.create({ name: 'strict', guards: [] })).rejects.toMatchObject({
        httpStatus: 409,
      });
      await expect(repo.create({ name: 'bad', guards: [{ type: 'pii' }] })).rejects.toThrow();
      expect(toPipelineProfile(a)).toMatchObject({
        profileId: a.id,
        latencyBudgetMs: 1500,
        onDrift: 'block',
        maxScanBytes: 1024,
      });
      expect(await repo.getOrgDefault()).toBeNull();
      await repo.setOrgDefault(a.id, audit);
      await repo.setOrgDefault(b.id, audit);
      expect((await repo.getOrgDefault())?.id).toBe(b.id);
      expect((await repo.get(a.id))?.isOrgDefault).toBe(false);
      expect(
        (await createOrgSettingsRepository(h.db.prisma).get('guards')).orgDefaultProfileId,
      ).toBe(b.id);
      await expect(repo.setOrgDefault(newId())).rejects.toMatchObject({ httpStatus: 404 });
      const etag = (await repo.getWithEtag(a.id))?.etag ?? '';
      const upd = await repo.update(
        a.id,
        { latencyBudgetMs: 900, guards: [], settings: {}, name: 'strict2' },
        { ifMatch: etag, audit },
      );
      expect(upd).toMatchObject({ latencyBudgetMs: 900, name: 'strict2' });
      await expect(repo.update(a.id, { name: 'late' }, { ifMatch: etag })).rejects.toMatchObject({
        httpStatus: 412,
      });
      await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      expect((await repo.list()).map((p) => p.name)).toEqual(['lenient', 'strict2']);
      await expect(repo.delete(b.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 409 });
      const entry = await createCatalogEntryRepository(h.db.prisma).create({
        slug: 'guarded',
        displayName: 'G',
        description: 'g',
        createdBy: author,
      });
      await createCatalogVersionRepository(h.db.prisma).create({
        entryId: entry.id,
        label: '1',
        serverSpec: spec,
        installForm: {},
        guardProfileId: a.id,
        createdBy: author,
      });
      await expect(repo.delete(a.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 409 });
      await repo.setOrgDefault(null, audit);
      expect(await repo.getOrgDefault()).toBeNull();
      await repo.delete(b.id, { ifMatch: '*', audit });
      await expect(repo.delete(b.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('13.6 definition pins per catalog version or installation: upsert is idempotent, pin set maps keys to hashes', async () => {
      const pins = createDefinitionPinRepository(h.db.prisma);
      const entry = await createCatalogEntryRepository(h.db.prisma).create({
        slug: 'pinned-entry',
        displayName: 'P',
        description: 'p',
        createdBy: author,
      });
      const version = await createCatalogVersionRepository(h.db.prisma).create({
        entryId: entry.id,
        label: '1',
        serverSpec: spec,
        installForm: {},
        createdBy: author,
      });
      const subject = { catalogVersionId: version.id };
      expect(await pins.pinSet(subject)).toBeNull();
      await pins.upsertPins(
        subject,
        [
          { itemKind: 'tool', itemKey: 'query', hash: hash('a'), definition: { name: 'query' } },
          {
            itemKind: 'resource',
            itemKey: 'file:///x',
            hash: hash('b'),
            definition: { uri: 'file:///x' },
            approvedBy: author,
          },
        ],
        audit,
      );
      await pins.upsertPins(subject, [
        {
          itemKind: 'tool',
          itemKey: 'query',
          hash: hash('a2'),
          definition: { name: 'query', v: 2 },
        },
      ]);
      await pins.upsertPins(subject, []);
      expect(await pins.pinSet(subject)).toEqual({
        'tool:query': hash('a2'),
        'resource:file:///x': hash('b'),
      });
      expect(
        (await pins.list(subject)).find((p) => p.itemKey === 'file:///x')?.approvedAt,
      ).not.toBeNull();
      // installation-owned pins are a separate set
      const installationId = newId();
      expect(await pins.pinSet({ installationId })).toBeNull();
      await pins.upsertPins({ installationId }, [
        { itemKind: 'prompt', itemKey: 'p', hash: hash('p'), definition: {} },
      ]);
      expect(await pins.pinSet({ installationId })).toEqual({ 'prompt:p': hash('p') });
      expect(await pins.remove(subject, 'tool', 'query')).toBe(true);
      expect(await pins.remove(subject, 'tool', 'query')).toBe(false);
      await expect(
        pins.upsertPins(subject, [
          { itemKind: 'widget' as never, itemKey: 'w', hash: hash('w'), definition: {} },
        ]),
      ).rejects.toThrow();
    });

    it('13.6 drift reviews: reports dedupe, approval re-pins and bumps versions, decisions are final', async () => {
      const reviews = createDriftReviewRepository(h.db.prisma);
      const pins = createDefinitionPinRepository(h.db.prisma);
      const entry = await createCatalogEntryRepository(h.db.prisma).create({
        slug: 'drift-entry',
        displayName: 'D',
        description: 'd',
        createdBy: author,
      });
      const version = await createCatalogVersionRepository(h.db.prisma).create({
        entryId: entry.id,
        label: '1',
        serverSpec: spec,
        installForm: {},
        createdBy: author,
      });
      const subject = { catalogVersionId: version.id };
      await pins.upsertPins(subject, [
        { itemKind: 'tool', itemKey: 'q', hash: hash('old'), definition: { v: 1 } },
      ]);
      const input = {
        itemKind: 'tool' as const,
        itemKey: 'q',
        oldHash: hash('old'),
        newHash: hash('new'),
        newDefinition: { v: 2 },
        guardResults: [{ guard: 'regex', verdict: 'clean' }],
      };
      const first = await reviews.open(subject, input);
      const again = await reviews.open(subject, input);
      expect(first.created).toBe(true);
      expect(again).toMatchObject({ created: false, review: { id: first.review.id } });
      const instReview = await reviews.open(
        { installationId: newId() },
        { ...input, oldHash: null },
      );
      expect(instReview.review.oldHash).toBeNull();
      expect(
        (await reviews.list({ status: 'open', catalogVersionId: version.id })).items,
      ).toHaveLength(1);
      expect(
        (await reviews.list({ installationId: instReview.review.installationId ?? '' })).items,
      ).toHaveLength(1);
      const pageOne = await reviews.list({ limit: 1 });
      expect(
        (await reviews.list({ limit: 1, cursor: pageOne.nextCursor ?? undefined })).items,
      ).toHaveLength(1);

      const before = await getConfigVersion(h.db.prisma, 'catalog', entry.id);
      const decided = await reviews.decide(
        first.review.id,
        { status: 'approved', decidedBy: author, reason: 'looks fine' },
        audit,
      );
      expect(decided).toMatchObject({
        status: 'approved',
        reason: 'looks fine',
        decidedBy: author,
      });
      expect((await pins.pinSet(subject))?.['tool:q']).toBe(hash('new'));
      expect(await getConfigVersion(h.db.prisma, 'catalog', entry.id)).toBe(before + 1n);
      await expect(
        reviews.decide(first.review.id, { status: 'rejected', decidedBy: author }),
      ).rejects.toMatchObject({ httpStatus: 409 });
      await expect(
        reviews.decide(newId(), { status: 'rejected', decidedBy: author }),
      ).rejects.toMatchObject({ httpStatus: 404 });
      const rejected = await reviews.decide(
        instReview.review.id,
        { status: 'rejected', decidedBy: author },
        audit,
      );
      expect(rejected.status).toBe('rejected');
      expect(
        await pins.pinSet({ installationId: instReview.review.installationId ?? '' }),
      ).toBeNull();
      // a review for a later change opens again after the previous one was decided
      const next = await reviews.open(subject, {
        ...input,
        oldHash: hash('new'),
        newHash: hash('newer'),
      });
      expect(next.created).toBe(true);
      expect(await reviews.get(first.review.id)).toMatchObject({ status: 'approved' });
      expect(await reviews.get(newId())).toBeNull();
      const approvedInstallation = await reviews.open(
        { installationId: newId() },
        { ...input, itemKey: 'z' },
      );
      await reviews.decide(approvedInstallation.review.id, {
        status: 'approved',
        decidedBy: author,
      });
    });
  },
);
