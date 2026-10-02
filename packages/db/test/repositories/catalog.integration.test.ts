import { createHash } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { getConfigVersion } from '../../src/config-version';
import {
  buildCatalogSearchTexts,
  createBlobStore,
  createCatalogEntryRepository,
  createCatalogFileStore,
  createCatalogVersionRepository,
  createConfigVersionRepository,
  createExecutableApprovalRepository,
  createNotificationRepository,
  createOrgSettingsRepository,
  createUserRepository,
  toolsOfSnapshot,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const audit = { actorType: 'user', actorId: newId() } as const;
const spec = { type: 'remote', transport: 'streamable-http', url: 'https://x.example/mcp', auth: { mode: 'none' } };

describe('11.2 catalog search document', () => {
  it('weights name, tags, description and tool texts', () => {
    const t = buildCatalogSearchTexts({
      name: 'BigQuery',
      slug: 'big-query',
      description: 'Run SQL',
      tags: ['data', 'sql'],
      tools: [{ name: 'run_query', description: 'Execute a query' }, { name: 'list.tables' }],
    });
    expect(t.a).toBe('BigQuery big query');
    expect(t.b).toBe('data sql');
    expect(t.d).toContain('run query Execute a query');
    expect(t.d).toContain('list tables');
  });

  it('reads tools from snapshot JSON and ignores malformed items', () => {
    expect(toolsOfSnapshot([{ name: 'a', description: 'b' }, 5, { nope: 1 }])).toEqual([
      { name: 'a', description: 'b' },
    ]);
    expect(toolsOfSnapshot('x')).toEqual([]);
  });
});

describe.skipIf(!dbEnabled())('16.2 catalog entries, versions, files, settings, notifications', () => {
  const h = useTestDb();
  const author = newId();

  const mkEntry = (slug: string, extra: Record<string, unknown> = {}) =>
    createCatalogEntryRepository(h.db.prisma).create(
      { slug, displayName: slug.toUpperCase(), description: `The ${slug} server`, createdBy: author, ...extra },
      audit,
    );

  it('11.1 creates entries with validated visibility, lists by filter and keyset cursor', async () => {
    const repo = createCatalogEntryRepository(h.db.prisma);
    const a = await mkEntry('alpha', { tags: ['data'], risk: 'low' });
    await mkEntry('beta', { tags: ['data', 'sql'], visibility: { org: true } });
    await mkEntry('gamma', { kind: 'skill' });
    await expect(mkEntry('alpha')).rejects.toMatchObject({ httpStatus: 409 });
    expect(a.visibility).toEqual({ org: false, teamIds: [], userIds: [] });
    expect((await repo.list({ tag: 'sql' })).items.map((e) => e.slug)).toEqual(['beta']);
    expect((await repo.list({ kind: 'skill' })).items.map((e) => e.slug)).toEqual(['gamma']);
    const p1 = await repo.list({ limit: 2 });
    const p2 = await repo.list({ limit: 2, cursor: p1.nextCursor ?? undefined });
    expect([...p1.items, ...p2.items].map((e) => e.slug).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(p2.nextCursor).toBeNull();
    expect(await repo.getBySlug('alpha')).toMatchObject({ id: a.id });
    expect(await repo.get(newId())).toBeNull();
    expect(await repo.getIcon(a.id)).toBeNull();
    expect(await getConfigVersion(h.db.prisma, 'catalog', a.id)).toBe(1n);
  });

  it('11.2 visibleTo returns org-wide, team-shared, user-shared and team-owned entries only', async () => {
    const repo = createCatalogEntryRepository(h.db.prisma);
    const team = newId();
    const user = newId();
    await h.db.prisma.team.create({ data: { id: team, slug: 'vis-team', displayName: 'V' } });
    await mkEntry('vis-org', { visibility: { org: true } });
    await mkEntry('vis-team-shared', { visibility: { teamIds: [team] } });
    await mkEntry('vis-user-shared', { visibility: { userIds: [user] } });
    await mkEntry('vis-owned', { ownerTeamId: team });
    await mkEntry('vis-hidden', { visibility: { teamIds: [newId()] } });
    const seen = (await repo.list({ visibleTo: { userId: user, teamIds: [team] }, limit: 100 })).items
      .map((e) => e.slug)
      .filter((s) => s.startsWith('vis-'))
      .sort();
    expect(seen).toEqual(['vis-org', 'vis-owned', 'vis-team-shared', 'vis-user-shared']);
    const noTeams = (await repo.list({ visibleTo: { userId: newId(), teamIds: [] }, limit: 100 })).items
      .map((e) => e.slug)
      .filter((s) => s.startsWith('vis-'));
    expect(noTeams).toEqual(['vis-org']);
  });

  it('11.2 search ranks by weighted full text across name, description, tags and reference-snapshot tools', async () => {
    const repo = createCatalogEntryRepository(h.db.prisma);
    const versions = createCatalogVersionRepository(h.db.prisma);
    const warehouse = await mkEntry('warehouse', { description: 'Analytics warehouse', tags: ['finance'] });
    const other = await mkEntry('notes', { description: 'Note taking', tags: [] });
    expect((await repo.search('warehouse')).items.map((e) => e.slug)).toEqual(['warehouse']);
    expect((await repo.search('finance')).items.map((e) => e.slug)).toEqual(['warehouse']);
    expect((await repo.search('nothingmatches')).items).toEqual([]);

    // Tool names of the reference snapshot join the document once the version is current.
    const snapshotId = newId();
    await h.db.prisma.upstreamSnapshot.create({
      data: {
        id: snapshotId,
        configHash: new Uint8Array(32),
        tools: [{ name: 'export_ledger', description: 'Dump the general ledger' }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
      },
    });
    const v = await versions.create({
      entryId: warehouse.id,
      label: '1.0.0',
      serverSpec: spec,
      installForm: { variables: [] },
      referenceSnapshotId: snapshotId,
      createdBy: author,
    });
    expect((await repo.search('ledger')).items).toEqual([]);
    await versions.publish(v.id, audit);
    expect((await repo.search('ledger')).items.map((e) => e.slug)).toEqual(['warehouse']);
    expect((await repo.search('export_ledger OR notes')).items.map((e) => e.slug).sort()).toEqual([
      'notes',
      'warehouse',
    ]);
    const paged = await repo.search('warehouse OR notes', { limit: 1 });
    expect(paged.items).toHaveLength(1);
    const next = await repo.search('warehouse OR notes', { limit: 1, cursor: paged.nextCursor ?? undefined });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(paged.items[0]?.id);
    expect((await repo.search('warehouse', { kind: 'skill' })).items).toEqual([]);
    await expect(repo.search('x', { cursor: 'bad!' })).rejects.toMatchObject({ httpStatus: 400 });
    await repo.reindexSearch(other.id);
    await repo.update(other.id, { description: 'Notebook' }, { ifMatch: '*' });
    expect((await repo.search('notebook')).items.map((e) => e.slug)).toEqual(['notes']);
  });

  it('17.1 update and delete need a matching ETag; deleting an installed entry conflicts', async () => {
    const repo = createCatalogEntryRepository(h.db.prisma);
    const e = await mkEntry('etagged');
    const etag = (await repo.getWithEtag(e.id))?.etag ?? '';
    const upd = await repo.update(
      e.id,
      { displayName: 'Etagged!', status: 'published', icon: new Uint8Array([1, 2, 3]), visibility: { org: true }, source: { type: 'registry' } },
      { ifMatch: etag, audit },
    );
    expect(upd).toMatchObject({ displayName: 'Etagged!', status: 'published', hasIcon: true, source: { type: 'registry' } });
    expect(Array.from((await repo.getIcon(e.id)) ?? [])).toEqual([1, 2, 3]);
    await expect(repo.update(e.id, { displayName: 'late' }, { ifMatch: etag })).rejects.toMatchObject({ httpStatus: 412 });
    await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
    await h.db.prisma.installation.create({
      data: { id: newId(), ownerType: 'user', ownerId: newId(), catalogEntryId: e.id, slug: 'i', toolPrefix: 'i', displayName: 'I', origin: 'manual' },
    });
    await expect(repo.delete(e.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 409 });
    const free = await mkEntry('deletable');
    await repo.delete(free.id, { ifMatch: '*', audit });
    expect(await repo.get(free.id)).toBeNull();
    await expect(repo.delete(free.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('11.1 versions: spec validated, drafts editable, publish freezes and becomes current, drafts deletable', async () => {
    const entries = createCatalogEntryRepository(h.db.prisma);
    const versions = createCatalogVersionRepository(h.db.prisma);
    const e = await mkEntry('versioned');
    await expect(
      versions.create({ entryId: e.id, label: 'bad', serverSpec: { type: 'package', runtime: 'npm', identifier: 'x', version: '^1.0', auth: { mode: 'none' } }, installForm: {}, createdBy: author }),
    ).rejects.toThrow();
    await expect(
      versions.create({ entryId: newId(), label: 'x', serverSpec: spec, installForm: {}, createdBy: author }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    const v1 = await versions.create({ entryId: e.id, label: '1.0.0', serverSpec: spec, installForm: { variables: [] }, runtime: { enableSampling: true, replicas: 3 }, createdBy: author }, audit);
    expect(v1.status).toBe('draft');
    expect(v1.runtime).toMatchObject({ enableSampling: true, replicas: 3, enableRoots: false });
    await expect(versions.create({ entryId: e.id, label: '1.0.0', serverSpec: spec, installForm: {}, createdBy: author })).rejects.toMatchObject({ httpStatus: 409 });
    const edited = await versions.update(v1.id, { changelog: 'first', overrides: { tools: {} }, limits: [{ id: 'l' }], lockfile: { a: 1 }, protocolEra: 'modern', guardProfileId: null, referenceSnapshotId: null, installForm: { variables: ['x'] }, runtime: { roots: ['file:///w'] }, serverSpec: spec }, audit);
    expect(edited).toMatchObject({ changelog: 'first', protocolEra: 'modern', limits: [{ id: 'l' }] });
    await versions.setTestResult(v1.id, { ok: true });
    expect((await versions.get(v1.id))?.testResult).toEqual({ ok: true });
    await versions.setTestResult(v1.id, null);

    const published = await versions.publish(v1.id, audit);
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();
    expect((await entries.get(e.id))?.currentVersionId).toBe(v1.id);
    expect((await entries.get(e.id))?.status).toBe('published');
    await expect(versions.update(v1.id, { changelog: 'x' })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(versions.publish(v1.id)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(versions.publish(newId())).rejects.toMatchObject({ httpStatus: 404 });
    await expect(versions.update(newId(), {})).rejects.toMatchObject({ httpStatus: 404 });

    const v2 = await versions.create({ entryId: e.id, label: '1.1.0', serverSpec: spec, installForm: {}, createdBy: author });
    expect((await versions.list(e.id)).map((v) => v.label)).toEqual(['1.1.0', '1.0.0']);
    expect(await versions.getByLabel(e.id, '1.1.0')).toMatchObject({ id: v2.id });
    expect(await versions.getByLabel(e.id, 'none')).toBeNull();
    await versions.delete(v2.id, audit);
    await expect(versions.delete(v2.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(versions.delete(v1.id)).rejects.toMatchObject({ httpStatus: 409 });
    await versions.markBroken(v1.id, audit);
    expect((await versions.get(v1.id))?.status).toBe('broken');
    await expect(versions.markBroken(newId())).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('25.2 blobs are content addressed and idempotent; published versions reject file changes', async () => {
    const blobs = createBlobStore(h.db.prisma);
    const files = createCatalogFileStore(h.db.prisma);
    const versions = createCatalogVersionRepository(h.db.prisma);
    const e = await mkEntry('skill-files', { kind: 'skill' });
    const v = await versions.create({ entryId: e.id, label: '1', serverSpec: {}, installForm: {}, createdBy: author });
    const body = new TextEncoder().encode('# Skill');
    const sha = await blobs.put(body);
    expect(sha).toBe(createHash('sha256').update(body).digest('hex'));
    expect(await blobs.put(body)).toBe(sha);
    expect(new TextDecoder().decode(await blobs.get(sha))).toBe('# Skill');
    expect(await blobs.get('00'.repeat(32))).toBeUndefined();

    await files.replace(v.id, [{ path: 'SKILL.md', blobSha256: sha, mode: 'file', classification: 'plain' }]);
    await files.replace(v.id, [
      { path: 'b.sh', blobSha256: sha, mode: 'executable', classification: 'executable' },
      { path: 'a.md', blobSha256: sha, mode: 'file', classification: 'plain' },
    ]);
    expect((await files.list(v.id)).map((f) => f.path)).toEqual(['a.md', 'b.sh']);
    await files.replace(v.id, []);
    expect(await files.list(v.id)).toEqual([]);
    await expect(files.replace(newId(), [])).rejects.toMatchObject({ httpStatus: 404 });
    await versions.publish(v.id);
    await expect(files.replace(v.id, [])).rejects.toMatchObject({ httpStatus: 409 });

    const approvals = createExecutableApprovalRepository(h.db.prisma);
    const diff = createHash('sha256').update('diff').digest('hex');
    const approved = await approvals.record({ catalogVersionId: v.id, approvedBy: author, reviewedDiffSha256: diff, note: 'ok' }, audit);
    expect(approved).toMatchObject({ reviewedDiffSha256: diff, note: 'ok' });
    await expect(approvals.record({ catalogVersionId: v.id, approvedBy: author, reviewedDiffSha256: diff })).rejects.toMatchObject({ httpStatus: 409 });
    expect((await approvals.get(v.id))?.approvedBy).toBe(author);
    await approvals.revoke(v.id, audit);
    await approvals.revoke(v.id, audit);
    expect(await approvals.get(v.id)).toBeNull();
  });

  it('19.2 org settings: defaults, zod-validated writes, ETag, registration source and token policy', async () => {
    const repo = createOrgSettingsRepository(h.db.prisma);
    expect((await repo.getAll()).logs.retentionDays).toBe(30);
    expect(await repo.patMaxDays()).toBe(90);
    expect(await repo.clientRegistration()).toEqual({ cimd: true, dcr: true, cimdHostAllowlist: [] });
    const before = await getConfigVersion(h.db.prisma, 'org');
    const logs = await repo.set('logs', { retentionDays: 14, capturePreviews: true, managerVisibility: true }, { updatedBy: author, audit });
    expect(logs.retentionDays).toBe(14);
    expect((await repo.get('logs')).capturePreviews).toBe(true);
    expect(await getConfigVersion(h.db.prisma, 'org')).toBe(before + 1n);
    await expect(
      repo.set('logs', { retentionDays: -1, capturePreviews: true, managerVisibility: true }),
    ).rejects.toMatchObject({ httpStatus: 422 });
    await expect(repo.set('nope' as never, 1 as never)).rejects.toMatchObject({ httpStatus: 422 });
    const { etag } = await repo.getWithEtag('logs');
    expect(etag).not.toBeNull();
    await repo.set('logs', { retentionDays: 7, capturePreviews: false, managerVisibility: true }, { ifMatch: etag ?? '' });
    await expect(
      repo.set('logs', { retentionDays: 8, capturePreviews: false, managerVisibility: true }, { ifMatch: etag ?? '' }),
    ).rejects.toMatchObject({ httpStatus: 412 });
    expect((await repo.getWithEtag('tokens')).etag).toBeNull();
    await repo.set('clientRegistration', { cimd: false, dcr: true, cimdHosts: ['a.example'], dcrPerIpPerHour: 5 });
    expect(await repo.clientRegistration()).toEqual({ cimd: false, dcr: true, cimdHostAllowlist: ['a.example'] });
    await h.db.prisma.orgSetting.create({ data: { key: 'legacy-unknown', value: {} } });
    expect((await repo.getAll()).logs.retentionDays).toBe(7);
  });

  it('notifications: create, list unread, mark read, count', async () => {
    const users = createUserRepository(h.db.prisma);
    const u = await users.create({ email: 'notify@acme.com', displayName: 'N' });
    const other = await users.create({ email: 'notify2@acme.com', displayName: 'N2' });
    const repo = createNotificationRepository(h.db.prisma);
    const a = await repo.create({ userId: u.id, kind: 'install.needs_setup', payload: { installationId: 'x' } });
    await repo.create({ userId: u.id, kind: 'drift.review' });
    await repo.create({ userId: other.id, kind: 'other' });
    expect(await repo.unreadCount(u.id)).toBe(2);
    expect(await repo.markRead(u.id, [a.id])).toBe(1);
    expect(await repo.markRead(u.id, [a.id])).toBe(0);
    expect(await repo.markRead(other.id, [a.id])).toBe(0);
    const unread = await repo.list(u.id, { unreadOnly: true });
    expect(unread.items.map((n) => n.kind)).toEqual(['drift.review']);
    const all = await repo.list(u.id, { limit: 1 });
    const rest = await repo.list(u.id, { limit: 1, cursor: all.nextCursor ?? undefined });
    expect([...all.items, ...rest.items]).toHaveLength(2);
    expect(await repo.markAllRead(u.id)).toBe(1);
    expect(await repo.unreadCount(u.id)).toBe(0);
  });

  it('4.3 config version listing', async () => {
    const repo = createConfigVersionRepository(h.db.prisma);
    expect((await repo.list('org')).length).toBe(1);
    expect((await repo.list()).length).toBeGreaterThan(1);
    expect(await repo.get('org')).toBeGreaterThan(0n);
  });
});
