/**
 * Deleting a catalog entry over the REAL Postgres schema (11.1, 11.3): hidden test installations and everything
 * hanging off versions and installations go with the entry, no foreign key blocks, no orphan rows are left, and real
 * installations or marketplaces still block with guidance.
 */
import { loadConfig, newId } from '@bastion-mcp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfra, type Infra } from '../src/infra';
import { type ApiHarness, buildApiHarness } from './helpers/api-app';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

const SPEC = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://upstream.example/mcp',
  auth: { mode: 'none' },
} as const;

describe.skipIf(!haveDocker())('11.1 deleting catalog entries over Postgres', () => {
  let env: TestEnv;
  let infra: Infra;
  let api: ApiHarness;
  const stopped: string[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    infra = createInfra(loadConfig(env.env()));
    api = await buildApiHarness(infra, {
      installations: {
        runtime: {
          stop: async (id: string) => {
            stopped.push(id);
          },
        },
      } as never,
    });
  });

  afterAll(async () => {
    await api.close();
    await infra.close();
    await env.cleanup();
  });

  const draft = async (slug: string) => {
    const entry = await api.call('POST', '/catalog', {
      body: { slug, displayName: slug, visibility: { org: true, teamIds: [], userIds: [] } },
    });
    expect(entry.status).toBe(201);
    const version = await api.call('POST', `/catalog/${entry.body.id}/versions`, {
      body: { label: '1', serverSpec: SPEC },
    });
    expect(version.status).toBe(201);
    return { entryId: entry.body.id as string, versionId: version.body.id as string };
  };

  const remove = async (entryId: string) => {
    const got = await api.call('GET', `/catalog/${entryId}`);
    return api.call('DELETE', `/catalog/${entryId}`, {
      headers: { 'if-match': String(got.headers.etag) },
    });
  };

  const orphans = async (versionId: string, installationId: string) => {
    const prisma = infra.db.prisma;
    const byBoth = { OR: [{ catalogVersionId: versionId }, { installationId }] };
    return {
      versions: await prisma.catalogVersion.count({ where: { id: versionId } }),
      snapshots: await prisma.upstreamSnapshot.count({ where: byBoth }),
      pins: await prisma.definitionPin.count({ where: byBoth }),
      drift: await prisma.driftReview.count({ where: byBoth }),
      installations: await prisma.installation.count({ where: { id: installationId } }),
      instances: await prisma.instance.count({ where: { installationId } }),
    };
  };

  it('11.1 deletes a never-tested draft with its files and approvals', async () => {
    const { entryId, versionId } = await draft('never-tested');
    const sha = await infra.repos.blobs.put(new Uint8Array(Buffer.from('hello')));
    await infra.db.prisma.catalogFile.create({
      data: {
        catalogVersionId: versionId,
        path: 'SKILL.md',
        blobSha256: Buffer.from(sha, 'hex'),
        mode: 'file',
        classification: 'plain',
      },
    });
    expect((await remove(entryId)).status).toBe(204);
    expect(await infra.db.prisma.catalogEntry.count({ where: { id: entryId } })).toBe(0);
    expect(await infra.db.prisma.catalogVersion.count({ where: { entryId } })).toBe(0);
    expect(
      await infra.db.prisma.catalogFile.count({ where: { catalogVersionId: versionId } }),
    ).toBe(0);
  });

  it('11.3 deletes a tested draft: the hidden test installation, its snapshots, pins and drift reviews go too', async () => {
    const { entryId, versionId } = await draft('tested-draft');
    const install = await infra.repos.installations.create({
      ownerType: 'user',
      ownerId: api.adminId,
      catalogEntryId: entryId,
      catalogVersionId: versionId,
      pinnedVersion: true,
      slug: `test-${versionId.replaceAll('-', '').slice(0, 10)}`,
      displayName: 'Test of tested-draft',
      enabled: false,
      variables: {},
      origin: 'test',
      status: 'ready',
    });
    const prisma = infra.db.prisma;
    await prisma.instance.create({
      data: {
        id: newId(),
        installationId: install.id,
        replica: 0,
        kind: 'sandbox',
        state: 'stopped',
      },
    });
    await prisma.installationPref.create({
      data: { installationId: install.id, userId: api.adminId },
    });
    const hash = Buffer.from('00', 'hex');
    // one row keyed by the version, one by the installation only: neither may survive
    for (const scope of [{ catalogVersionId: versionId }, { installationId: install.id }]) {
      await prisma.upstreamSnapshot.create({
        data: {
          id: newId(),
          ...scope,
          configHash: hash,
          tools: [],
          prompts: [],
          resources: [],
          resourceTemplates: [],
        },
      });
      await prisma.definitionPin.create({
        data: { id: newId(), ...scope, itemKind: 'tool', itemKey: 'echo', hash, definition: {} },
      });
      await prisma.driftReview.create({
        data: {
          id: newId(),
          ...scope,
          itemKind: 'tool',
          itemKey: 'echo',
          newHash: hash,
          newDefinition: {},
          guardResults: {},
        },
      });
    }
    expect(await orphans(versionId, install.id)).toMatchObject({
      versions: 1,
      snapshots: 2,
      pins: 2,
      drift: 2,
      installations: 1,
    });

    const res = await remove(entryId);
    expect(res.status).toBe(204);
    expect(stopped).toContain(install.id);
    expect(await orphans(versionId, install.id)).toEqual({
      versions: 0,
      snapshots: 0,
      pins: 0,
      drift: 0,
      installations: 0,
      instances: 0,
    });
    expect(await prisma.installationPref.count({ where: { installationId: install.id } })).toBe(0);
    expect(await prisma.catalogEntry.count({ where: { id: entryId } })).toBe(0);
  });

  it('11.1 a published entry with real installations is a 409 with guidance; deprecate and archive work; without them it deletes', async () => {
    const { entryId, versionId } = await draft('published-used');
    const prisma = infra.db.prisma;
    await prisma.catalogVersion.update({
      where: { id: versionId },
      data: { status: 'published', testResult: { status: 'passed' } },
    });
    await prisma.catalogEntry.update({
      where: { id: entryId },
      data: { status: 'published', currentVersionId: versionId },
    });
    const real = await infra.repos.installations.create({
      ownerType: 'user',
      ownerId: api.adminId,
      catalogEntryId: entryId,
      catalogVersionId: versionId,
      pinnedVersion: false,
      slug: 'real-install',
      displayName: 'Real',
      enabled: true,
      variables: {},
      origin: 'catalog',
      status: 'ready',
    });
    const blocked = await remove(entryId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('entry_in_use');
    expect(JSON.stringify(blocked.body)).toMatch(
      /1 installation uses this entry.*Deprecate it to hide it from the Store, or remove the installations first/s,
    );
    expect(await prisma.catalogEntry.count({ where: { id: entryId } })).toBe(1);

    const inStore = async () =>
      (await api.call('GET', '/store')).body.items.map((e: { id: string }) => e.id);
    expect(await inStore()).toContain(entryId);
    const got = await api.call('GET', `/catalog/${entryId}`);
    const dep = await api.call('PATCH', `/catalog/${entryId}`, {
      headers: { 'if-match': String(got.headers.etag) },
      body: { status: 'deprecated' },
    });
    expect(dep.status).toBe(200);
    expect(await inStore()).not.toContain(entryId);
    const got2 = await api.call('GET', `/catalog/${entryId}`);
    const arch = await api.call('PATCH', `/catalog/${entryId}`, {
      headers: { 'if-match': String(got2.headers.etag) },
      body: { status: 'archived' },
    });
    expect(arch.body.status).toBe('archived');

    await prisma.installation.delete({ where: { id: real.id } });
    expect((await remove(entryId)).status).toBe(204);
  });

  it('25.4 an entry that is part of a marketplace is a 409 with guidance, never a foreign-key error', async () => {
    const { entryId } = await draft('in-marketplace');
    const prisma = infra.db.prisma;
    const marketId = newId();
    await prisma.marketplace.create({
      data: {
        id: marketId,
        slug: 'mk-delete',
        displayName: 'MK',
        audience: { org: true, teamIds: [], userIds: [] },
        desktopInstallation: 'available',
        createdBy: api.adminId,
      },
    });
    await prisma.marketplaceItem.create({
      data: { marketplaceId: marketId, catalogEntryId: entryId, policy: 'available', position: 0 },
    });
    const res = await remove(entryId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('entry_in_use');
    expect(await prisma.catalogEntry.count({ where: { id: entryId } })).toBe(1);
    expect(await prisma.catalogVersion.count({ where: { entryId } })).toBe(1);
    await prisma.marketplaceItem.deleteMany({ where: { marketplaceId: marketId } });
    expect((await remove(entryId)).status).toBe(204);
  });
});
