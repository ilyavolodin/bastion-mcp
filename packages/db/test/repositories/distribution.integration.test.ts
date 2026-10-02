import { createHash } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { dropPartitionsBefore } from '../../src/partitions';
import {
  createBlobStore,
  createCatalogEntryRepository,
  createCatalogFileStore,
  createCatalogVersionRepository,
  createDistributionEventSink,
  createInstallRequestStore,
  createMarketplaceRepository,
  createMarketplaceStore,
  createPluginSourceRepository,
  createRegistryPolicyStore,
  createRegistryServerStore,
  createRegistrySourceStore,
  createReleaseStore,
  createUserRepository,
  type InstallRequestRecord,
  type RegistryServerRow,
  type RegistrySourceRecord,
  type SyncStats,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const audit = { actorType: 'user', actorId: newId() } as const;
const author = newId();
const stats = (over: Partial<SyncStats> = {}): SyncStats => ({
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:05Z',
  ok: true,
  full: true,
  pages: 1,
  fetched: 3,
  upserted: 3,
  invalid: 0,
  deleted: 0,
  deprecated: 0,
  ...over,
});

describe.skipIf(!dbEnabled())('11.6 registry sources, servers and install requests', () => {
  const h = useTestDb();

  const source = (
    name: string,
    over: Partial<RegistrySourceRecord> = {},
  ): RegistrySourceRecord => ({
    id: newId(),
    name,
    baseUrl: `https://${name}.example`,
    trust: 'community',
    enabled: true,
    syncIntervalS: 3600,
    lastUpdatedSince: null,
    lastSync: null,
    ...over,
  });

  const server = (
    sourceId: string,
    name: string,
    version: string,
    doc: string,
    over: Partial<RegistryServerRow> = {},
  ): RegistryServerRow => ({
    sourceId,
    name,
    version,
    serverJson: { name, version, description: doc },
    status: 'active',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    isLatest: true,
    meta: { k: 1 },
    searchDocument: `${name} ${doc}`,
    ...over,
  });

  it('11.6 sources: save, update, unique base_url, sync bookkeeping, remove cascades servers', async () => {
    const store = createRegistrySourceStore(h.db.prisma);
    const servers = createRegistryServerStore(h.db.prisma);
    const s = source('alpha', { authSecretId: newId(), authHeaderName: 'X-Token' });
    await store.save(s, audit);
    expect(await store.get(s.id)).toMatchObject({
      name: 'alpha',
      authHeaderName: 'X-Token',
      lastSync: null,
    });
    await store.save({ ...s, enabled: false, name: 'alpha2' }, audit);
    expect(await store.get(s.id)).toMatchObject({ enabled: false, name: 'alpha2' });
    await expect(store.save(source('alpha'), audit)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await store.get(newId())).toBeNull();
    const since = new Date('2026-02-01T00:00:00Z');
    await store.recordSync(s.id, { lastSync: stats(), lastUpdatedSince: since });
    await store.recordSync(s.id, { lastSync: stats({ ok: false, error: 'boom' }) });
    const after = await store.get(s.id);
    expect(after?.lastUpdatedSince?.getTime()).toBe(since.getTime());
    expect(after?.lastSync).toMatchObject({ ok: false, error: 'boom' });
    await servers.upsert([server(s.id, 'io.x/one', '1.0.0', 'one')]);
    expect((await store.list()).map((x) => x.name)).toContain('alpha2');
    await store.remove(s.id, audit);
    expect(await servers.list(s.id)).toEqual([]);
    await expect(store.remove(s.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('11.6 servers: idempotent upsert, list by name, full-text search ranked and paged, keyset without a query', async () => {
    const sources = createRegistrySourceStore(h.db.prisma);
    const servers = createRegistryServerStore(h.db.prisma);
    const a = source('srv-a');
    const b = source('srv-b');
    await sources.save(a);
    await sources.save(b);
    await servers.upsert([]);
    await servers.upsert([
      server(a.id, 'io.acme/postgres', '1.0.0', 'Query PostgreSQL databases', { isLatest: false }),
      server(a.id, 'io.acme/postgres', '1.1.0', 'Query PostgreSQL databases with SQL'),
      server(a.id, 'io.acme/slack', '2.0.0', 'Send Slack messages'),
      server(b.id, 'io.other/slack', '0.1.0', 'Another Slack bridge', { status: 'deprecated' }),
      server(b.id, 'io.other/gone', '0.1.0', 'Removed Slack thing', { status: 'deleted' }),
    ]);
    await servers.upsert([
      server(a.id, 'io.acme/slack', '2.0.0', 'Send Slack messages and files', { meta: { k: 2 } }),
    ]);
    const listed = await servers.list(a.id);
    expect(listed.map((r) => `${r.name}@${r.version}`)).toEqual([
      'io.acme/postgres@1.0.0',
      'io.acme/postgres@1.1.0',
      'io.acme/slack@2.0.0',
    ]);
    expect(listed[2]?.meta).toEqual({ k: 2 });
    expect((await servers.list(a.id, { name: 'io.acme/slack' })).length).toBe(1);

    const hits = await servers.search({ q: 'slack', limit: 10 });
    expect(hits.items.map((r) => r.name).sort()).toEqual(['io.acme/slack', 'io.other/slack']);
    expect(hits.nextCursor).toBeUndefined();
    expect(
      (await servers.search({ q: 'slack', limit: 10, includeDeleted: true })).items.map(
        (r) => r.name,
      ),
    ).toContain('io.other/gone');
    expect(
      (await servers.search({ q: 'postgresql', limit: 10, latestOnly: false })).items,
    ).toHaveLength(2);
    expect((await servers.search({ q: 'postgresql', limit: 10 })).items).toHaveLength(1);
    expect(
      (await servers.search({ q: 'slack', sourceId: b.id, limit: 10 })).items.map((r) => r.name),
    ).toEqual(['io.other/slack']);
    const p1 = await servers.search({ q: 'slack', limit: 1 });
    expect(p1.items).toHaveLength(1);
    const p2 = await servers.search({ q: 'slack', limit: 1, cursor: p1.nextCursor });
    expect(p2.items[0]?.name).not.toBe(p1.items[0]?.name);

    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await servers.search({ limit: 2, cursor, sourceId: a.id, latestOnly: false });
      all.push(...page.items.map((r) => `${r.name}@${r.version}`));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(all).toEqual([
      'io.acme/postgres@1.0.0',
      'io.acme/postgres@1.1.0',
      'io.acme/slack@2.0.0',
    ]);
    await expect(
      servers.search({ limit: 2, cursor: Buffer.from('["x"]').toString('base64url') }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      servers.search({ q: 'x', limit: 2, cursor: Buffer.from('["x"]').toString('base64url') }),
    ).rejects.toMatchObject({ httpStatus: 400 });

    // a re-sync that no longer lists a version marks it deleted
    const changed = await servers.markMissingDeleted(a.id, [
      { name: 'io.acme/postgres', version: '1.1.0' },
      { name: 'io.acme/slack', version: '2.0.0' },
    ]);
    expect(changed).toBe(1);
    expect((await servers.list(a.id)).find((r) => r.version === '1.0.0')?.status).toBe('deleted');
    await expect(
      h.db.prisma.registryServer.update({
        where: {
          sourceId_name_version: { sourceId: a.id, name: 'io.acme/slack', version: '2.0.0' },
        },
        data: { status: 'weird' },
      }),
    ).rejects.toThrow();
  });

  it('11.6 browse: 600 rows upsert in batches, one page per call, cursor continuity, disabled sources and runtime filter', async () => {
    const sources = createRegistrySourceStore(h.db.prisma);
    const servers = createRegistryServerStore(h.db.prisma);
    const on = source('bulk-on');
    const off = source('bulk-off', { enabled: false });
    await sources.save(on);
    await sources.save(off);
    const rows = (sourceId: string, n: number, tag: string) =>
      Array.from({ length: n }, (_, i): RegistryServerRow => {
        const name = `io.bulk/${tag}-${String(i).padStart(4, '0')}`;
        const base = server(sourceId, name, '1.0.0', `bulk ${tag} server number ${i}`);
        return i % 3 === 0
          ? {
              ...base,
              serverJson: {
                ...base.serverJson,
                remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp' }],
              },
            }
          : i % 3 === 1
            ? {
                ...base,
                serverJson: {
                  ...base.serverJson,
                  packages: [{ registryType: 'npm', identifier: name }],
                },
              }
            : {
                ...base,
                serverJson: {
                  ...base.serverJson,
                  packages: [{ registryType: 'pypi', identifier: name }],
                },
              };
      });
    const batch = rows(on.id, 500, 'on');
    for (let i = 0; i < batch.length; i += 100) await servers.upsert(batch.slice(i, i + 100));
    // the same batch twice, and a duplicate inside one batch, are idempotent
    await servers.upsert([...batch.slice(0, 100), batch[0] as RegistryServerRow]);
    await servers.upsert(rows(off.id, 100, 'off'));
    expect((await servers.list(on.id)).length).toBe(500);

    // only enabled sources, 24 per page, never the whole table
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await servers.search({ limit: 24, cursor, enabledSourcesOnly: true });
      expect(page.items.length).toBeLessThanOrEqual(24);
      seen.push(...page.items.map((r) => r.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 100);
    const bulkSeen = seen.filter((n) => n.startsWith('io.bulk/'));
    // other tests of this file leave a few rows behind; the 100 rows of the disabled source never appear
    expect(bulkSeen).toHaveLength(500);
    expect(new Set(seen).size).toBe(seen.length);
    expect(bulkSeen.every((n) => n.includes('/on-'))).toBe(true);
    expect(pages).toBeGreaterThanOrEqual(21);
    // disabled sources appear when asked for
    expect((await servers.search({ limit: 200, sourceId: off.id })).items).toHaveLength(100);
    // runtime filters
    const remote = await servers.search({
      limit: 200,
      enabledSourcesOnly: true,
      runtime: 'remote',
    });
    expect(remote.items.filter((r) => r.name.startsWith('io.bulk/'))).toHaveLength(167);
    const pypi = await servers.search({ limit: 200, enabledSourcesOnly: true, runtime: 'pypi' });
    expect(
      pypi.items.every(
        (r) =>
          (r.serverJson as { packages?: { registryType: string }[] }).packages?.[0]
            ?.registryType === 'pypi',
      ),
    ).toBe(true);
    // search pages by rank and restarts at the first page for a new query
    const p1 = await servers.search({ q: 'bulk', limit: 24, enabledSourcesOnly: true });
    expect(p1.items).toHaveLength(24);
    const p2 = await servers.search({
      q: 'bulk',
      limit: 24,
      enabledSourcesOnly: true,
      cursor: p1.nextCursor,
    });
    expect(p2.items.map((r) => r.name)).not.toEqual(p1.items.map((r) => r.name));
    expect(
      (await servers.search({ q: 'number 7', limit: 24, enabledSourcesOnly: true })).items.length,
    ).toBeGreaterThan(0);
  });

  it('11.7 registry policy per source and install requests with optimistic decisions', async () => {
    const sources = createRegistrySourceStore(h.db.prisma);
    const s = source('policy-src');
    await sources.save(s);
    const policies = createRegistryPolicyStore(h.db.prisma);
    expect(await policies.get(s.id)).toBeNull();
    await policies.set(s.id, { mode: 'request' }, audit);
    await policies.set(s.id, { mode: 'direct' }, audit);
    expect(await policies.get(s.id)).toEqual({ mode: 'direct' });

    const user = await createUserRepository(h.db.prisma).create({
      email: 'requester@acme.com',
      displayName: 'R',
    });
    const requests = createInstallRequestStore(h.db.prisma);
    const req: InstallRequestRecord = {
      id: newId(),
      requesterId: user.id,
      sourceId: s.id,
      serverName: 'io.x/y',
      version: '1.0.0',
      justification: 'need it',
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      reason: null,
      createdAt: new Date(),
    };
    await requests.create(req, audit);
    await requests.create({ ...req, id: newId(), status: 'open', serverName: 'io.x/z' });
    expect(await requests.get(req.id)).toMatchObject({ serverName: 'io.x/y', status: 'open' });
    expect(await requests.get(newId())).toBeNull();
    const approved: InstallRequestRecord = {
      ...req,
      status: 'approved',
      decidedBy: author,
      decidedAt: new Date(),
      reason: 'ok',
    };
    await requests.save(approved, audit);
    expect(await requests.get(req.id)).toMatchObject({ status: 'approved', reason: 'ok' });
    await expect(requests.save({ ...req, status: 'cancelled' })).rejects.toMatchObject({
      httpStatus: 409,
    });
    await expect(requests.save({ ...req, id: newId() })).rejects.toMatchObject({ httpStatus: 404 });
    expect(
      (await requests.list({ requesterId: user.id, status: 'open' })).map((r) => r.serverName),
    ).toEqual(['io.x/z']);
    expect(await requests.list()).toHaveLength(2);
    const page = await requests.listPage({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(
      (
        await requests.listPage({
          limit: 1,
          cursor: page.nextCursor ?? undefined,
          status: undefined,
        })
      ).items,
    ).toHaveLength(1);
  });
});

describe.skipIf(!dbEnabled())(
  '25.4 marketplaces, releases, distribution events, plugin sources',
  () => {
    const h = useTestDb();

    type Item = {
      name: string;
      version: string;
      policy: 'available' | 'installedByDefault' | 'required';
      files: string[];
      skills: string[];
    };

    const mkPlugin = async (slug: string, files: Record<string, string>) => {
      const entries = createCatalogEntryRepository(h.db.prisma);
      const versions = createCatalogVersionRepository(h.db.prisma);
      const blobs = createBlobStore(h.db.prisma);
      const fileStore = createCatalogFileStore(h.db.prisma);
      const entry = await entries.create({
        slug,
        kind: 'plugin',
        displayName: slug,
        description: 'p',
        createdBy: author,
      });
      const v = await versions.create({
        entryId: entry.id,
        label: '1.0.0',
        serverSpec: {},
        installForm: {},
        createdBy: author,
      });
      const rows = [];
      for (const [path, text] of Object.entries(files)) {
        rows.push({
          path,
          blobSha256: await blobs.put(new TextEncoder().encode(text)),
          mode: 'file' as const,
          classification: 'plain' as const,
        });
      }
      await fileStore.replace(v.id, rows);
      await versions.publish(v.id);
      return { entry, version: v };
    };

    const assemble = async (
      src: Parameters<Parameters<typeof createMarketplaceStore<Item>>[1]['assemble']>[0],
    ): Promise<Item> => {
      const skills: string[] = [];
      for (const f of src.files.filter((x) => x.path.startsWith('uses/'))) {
        const slug = new TextDecoder().decode(f.content);
        const skill = await src.loadSkillFiles(slug);
        if (skill) skills.push(`${skill.slug}:${skill.files.length}`);
      }
      return {
        name: src.entry.slug,
        version: src.version.label,
        policy: src.policy,
        files: src.files.map((f) => f.path),
        skills,
      };
    };

    it('administers marketplaces: validation, ETag, items by position, audit', async () => {
      const repo = createMarketplaceRepository(h.db.prisma);
      await expect(
        repo.create({ slug: 'Bad Slug', displayName: 'x', audience: {}, createdBy: author }),
      ).rejects.toMatchObject({ httpStatus: 422 });
      const m = await repo.create(
        {
          slug: 'acme-tools',
          displayName: 'Acme',
          audience: { org: true },
          createdBy: author,
          mirror: {
            provider: 'github',
            repo: 'acme/x',
            branch: 'main',
            credentialSecretId: newId(),
          },
        },
        audit,
      );
      expect(m).toMatchObject({ desktopInstallation: 'available', promotedRelease: null });
      await expect(
        repo.create({ slug: 'acme-tools', displayName: 'dup', audience: {}, createdBy: author }),
      ).rejects.toMatchObject({ httpStatus: 409 });
      expect((await repo.getBySlug('acme-tools'))?.id).toBe(m.id);
      expect((await repo.list()).map((x) => x.slug)).toEqual(['acme-tools']);
      const etag = (await repo.getWithEtag(m.id))?.etag ?? '';
      const upd = await repo.update(
        m.id,
        {
          description: 'Tools',
          desktopInstallation: 'required',
          audience: { teams: [] },
          mirror: null,
        },
        { ifMatch: etag, audit },
      );
      expect(upd).toMatchObject({
        description: 'Tools',
        desktopInstallation: 'required',
        mirror: null,
      });
      await expect(
        repo.update(m.id, { displayName: 'late' }, { ifMatch: etag }),
      ).rejects.toMatchObject({ httpStatus: 412 });
      await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
        httpStatus: 404,
      });
      await repo.update(
        m.id,
        { mirror: { provider: 'gitlab', repo: 'g/p', branch: 'm', credentialSecretId: 'c' } },
        { ifMatch: '*' },
      );

      const p1 = await mkPlugin('plug-one', { 'plugin.json': '{}' });
      const p2 = await mkPlugin('plug-two', { 'plugin.json': '{}' });
      await repo.replaceItems(
        m.id,
        [
          { catalogEntryId: p2.entry.id, policy: 'required' },
          { catalogEntryId: p1.entry.id, policy: 'available', pinnedVersionId: p1.version.id },
        ],
        audit,
      );
      expect((await repo.listItems(m.id)).map((i) => [i.catalogEntryId, i.position])).toEqual([
        [p2.entry.id, 0],
        [p1.entry.id, 1],
      ]);
      await expect(
        repo.replaceItems(m.id, [
          { catalogEntryId: p1.entry.id, policy: 'available', pinnedVersionId: p2.version.id },
        ]),
      ).rejects.toMatchObject({ httpStatus: 422 });
      await expect(
        repo.replaceItems(m.id, [
          { catalogEntryId: p1.entry.id, policy: 'available' },
          { catalogEntryId: p1.entry.id, policy: 'required' },
        ]),
      ).rejects.toMatchObject({ httpStatus: 422 });
      await expect(repo.replaceItems(newId(), [])).rejects.toMatchObject({ httpStatus: 404 });
      await repo.replaceItems(m.id, []);
      expect(await repo.listItems(m.id)).toEqual([]);
      await repo.delete(m.id, { ifMatch: '*', audit });
      await expect(repo.delete(m.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
      expect(await repo.get(m.id)).toBeNull();
      expect(await repo.getWithEtag(m.id)).toBeNull();
    });

    it('resolves items (follow-current or pinned), builds releases once, replays past releases', async () => {
      const admin = createMarketplaceRepository(h.db.prisma);
      const team = newId();
      await h.db.prisma.team.create({
        data: { id: team, slug: 'owners', displayName: 'Owners Team' },
      });
      const m = await admin.create({
        slug: 'release-mkt',
        displayName: 'Rel',
        description: 'D',
        ownerTeamId: team,
        audience: {},
        createdBy: author,
      });
      const skill = await mkPlugin('shared-skill', { 'SKILL.md': '# s' });
      const plug = await mkPlugin('release-plugin', {
        'plugin.json': '{}',
        'uses/a.txt': 'shared-skill',
      });
      await admin.replaceItems(m.id, [
        { catalogEntryId: plug.entry.id, policy: 'installedByDefault' },
        { catalogEntryId: skill.entry.id, policy: 'available' },
      ]);
      const store = createMarketplaceStore<Item>(h.db.prisma, {
        assemble,
        defaultOwnerName: async () => 'Org',
      });
      expect(await store.getBySlug('nope')).toBeUndefined();
      expect(await store.getById(newId())).toBeUndefined();
      expect(await store.getById(m.id)).toMatchObject({
        slug: 'release-mkt',
        ownerName: 'Owners Team',
        description: 'D',
        promotedRelease: null,
      });
      const noOwner = await admin.create({
        slug: 'no-owner',
        displayName: 'N',
        audience: {},
        createdBy: author,
      });
      expect(await store.getBySlug(noOwner.slug)).toMatchObject({ ownerName: 'Org' });
      const plain = createMarketplaceStore<Item>(h.db.prisma, { assemble });
      expect((await plain.getBySlug(noOwner.slug))?.ownerName).toBe('Bastion');

      const resolved = await store.resolveItems(m.id);
      expect(resolved.map((r) => [r.name, r.policy, r.files.length, r.skills])).toEqual([
        ['release-plugin', 'installedByDefault', 2, ['shared-skill:1']],
        ['shared-skill', 'available', 1, []],
      ]);
      expect(resolved[0]).toMatchObject({ entryId: plug.entry.id, versionId: plug.version.id });

      const releases = createReleaseStore(h.db.prisma);
      expect(await releases.latest(m.id)).toBeUndefined();
      const sha = (v: string) => createHash('sha256').update(v).digest('hex');
      const record = (seq: number) => ({
        seq,
        items: resolved.map((r) => ({ name: r.name, version: r.version, policy: r.policy })),
        gitCommit: sha(`commit${seq}`),
        claudeManifestSha256: sha('claude'),
        agentsManifestSha256: sha('agents'),
        archives: { 'release-plugin': { version: '1.0.0', sha256: sha('zip') } },
        releaseTime: '2026-03-01T10:00:00.000Z',
      });
      const refs = resolved.map((r) => ({
        entryId: r.entryId,
        versionId: r.versionId,
        policy: r.policy,
      }));
      await releases.insert(m.id, record(1), refs, author, audit);
      await expect(releases.insert(m.id, record(1), refs, null)).rejects.toMatchObject({
        httpStatus: 409,
      });
      await expect(releases.insert(m.id, record(2), refs.slice(1), null)).rejects.toMatchObject({
        httpStatus: 422,
      });
      const concurrent = await Promise.allSettled([
        releases.insert(m.id, record(2), refs, null),
        releases.insert(m.id, record(2), refs, null),
      ]);
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await releases.get(m.id, 1)).toEqual(record(1));
      expect(await releases.get(m.id, 9)).toBeUndefined();
      expect((await releases.latest(m.id))?.seq).toBe(2);
      expect((await releases.list(m.id)).map((r) => r.seq)).toEqual([1, 2]);

      // a new plugin version does not change what release 1 replays
      const versions = createCatalogVersionRepository(h.db.prisma);
      const v2 = await versions.create({
        entryId: plug.entry.id,
        label: '2.0.0',
        serverSpec: {},
        installForm: {},
        createdBy: author,
      });
      await versions.publish(v2.id);
      expect(
        (await store.resolveItems(m.id)).find((r) => r.name === 'release-plugin')?.version,
      ).toBe('2.0.0');
      expect((await store.loadReleaseItems(m.id, 1)).map((r) => r.version)).toEqual([
        '1.0.0',
        '1.0.0',
      ]);
      await expect(store.loadReleaseItems(m.id, 7)).rejects.toMatchObject({ httpStatus: 404 });

      // pinned items stay, archived entries drop out
      await admin.replaceItems(m.id, [
        { catalogEntryId: plug.entry.id, policy: 'required', pinnedVersionId: plug.version.id },
        { catalogEntryId: skill.entry.id, policy: 'available' },
      ]);
      expect(
        (await store.resolveItems(m.id)).find((r) => r.name === 'release-plugin')?.version,
      ).toBe('1.0.0');
      await createCatalogEntryRepository(h.db.prisma).update(
        skill.entry.id,
        { status: 'archived' },
        { ifMatch: '*' },
      );
      expect((await store.resolveItems(m.id)).map((r) => r.name)).toEqual(['release-plugin']);

      await store.setPromotedRelease(m.id, 2, audit);
      expect((await store.getById(m.id))?.promotedRelease).toBe(2);
      await expect(store.setPromotedRelease(m.id, 99)).rejects.toMatchObject({ httpStatus: 404 });
      const state = {
        status: 'retrying' as const,
        lastPushedSeq: 1,
        attempts: 2,
        nextAttemptAt: '2026-03-01T10:05:00Z',
        lastError: 'x',
        updatedAt: '2026-03-01T10:00:00Z',
      };
      await store.setMirrorStatus(m.id, state);
      expect((await store.getById(m.id))?.mirrorStatus).toEqual(state);
    });

    it('25.9 distribution events land in the daily partition, creating a missing one', async () => {
      const sink = createDistributionEventSink(h.db.prisma);
      const marketplaceId = newId();
      await sink.record({
        ts: new Date(),
        principalId: newId(),
        marketplaceId,
        releaseSeq: 1,
        channel: 'git',
        action: 'git_fetch',
        userAgent: 'git/2',
      });
      await sink.recordMany([]);
      await sink.recordMany([
        {
          ts: new Date(),
          principalId: newId(),
          marketplaceId,
          releaseSeq: null,
          channel: 'https',
          action: 'manifest_fetch',
          userAgent: null,
        },
        {
          ts: new Date(),
          principalId: newId(),
          marketplaceId,
          releaseSeq: 2,
          channel: 'mirror',
          action: 'mirror_push',
          userAgent: null,
        },
      ]);
      expect(await h.db.prisma.distributionEvent.count({ where: { marketplaceId } })).toBe(3);
      // drop every partition, then record: the sink recreates today's partition
      await dropPartitionsBefore(
        h.db.prisma,
        'distribution_events',
        new Date(Date.now() + 30 * 86_400_000),
      );
      await sink.record({
        ts: new Date(),
        principalId: newId(),
        marketplaceId,
        releaseSeq: 3,
        channel: 'git',
        action: 'git_fetch',
        userAgent: null,
      });
      expect(await h.db.prisma.distributionEvent.count({ where: { marketplaceId } })).toBe(1);
      await expect(
        sink.record({
          ts: new Date(),
          principalId: newId(),
          marketplaceId,
          releaseSeq: 3,
          channel: 'ftp' as never,
          action: 'git_fetch',
          userAgent: null,
        }),
      ).rejects.toThrow();
    });

    it('25.1 plugin sources: create, sync bookkeeping, delete', async () => {
      const repo = createPluginSourceRepository(h.db.prisma);
      const s = await repo.create(
        { name: 'internal', gitUrl: 'https://git.example/plugins.git' },
        audit,
      );
      expect(s).toMatchObject({ ref: 'main', tracked: true, lastSync: null });
      await repo.recordSync(s.id, { lastCommit: 'abc', lastSync: { ok: true } });
      expect(await repo.get(s.id)).toMatchObject({ lastCommit: 'abc', lastSync: { ok: true } });
      expect((await repo.list()).map((x) => x.name)).toEqual(['internal']);
      expect(await repo.get(newId())).toBeNull();
      await repo.delete(s.id, audit);
      await expect(repo.delete(s.id)).rejects.toMatchObject({ httpStatus: 404 });
    });
  },
);
