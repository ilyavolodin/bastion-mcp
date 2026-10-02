import { sha256Hex } from '@bastion-mcp/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiDeps } from '../src/ports';
import type { FakeImports, FakeVersionTests } from './helpers/fakes/catalog';
import { makeFakeInstallations } from './helpers/fakes/installations';
import { buildTestApi, type TestApi } from './helpers/harness';
import { REMOTE_SPEC, SEED_FILES } from './helpers/seeds/catalog';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const items = (v: unknown): Array<Record<string, unknown>> =>
  rec(v).items as Array<Record<string, unknown>>;
const b64 = (text: string) => Buffer.from(text).toString('base64');
const etagOf = async (t: TestApi, actor: 'admin' | 'managerOwn', url: string) =>
  String((await t.call(actor, 'GET', url)).headers.etag);

describe('11.1 catalog entries', () => {
  it('11.1 admin sees every entry, a team member only those visible to them', async () => {
    api = await buildTestApi();
    const all = items((await api.call('admin', 'GET', '/catalog')).body).map((e) => e.id);
    expect(all).toEqual(
      expect.arrayContaining(['entry-team-a', 'entry-org', 'entry-team-b', 'entry-plugin']),
    );
    const member = items((await api.call('member', 'GET', '/catalog')).body).map((e) => e.id);
    expect(member).toContain('entry-team-a');
    expect(member).toContain('entry-org');
    expect(member).not.toContain('entry-team-b');
  });

  it('11.1 filtered lists fill the page and keep paging', async () => {
    api = await buildTestApi();
    const first = await api.call('member', 'GET', '/catalog', { query: { limit: '1' } });
    expect(items(first.body)).toHaveLength(1);
    expect(rec(first.body).nextCursor).not.toBeNull();
    const second = await api.call('member', 'GET', '/catalog', {
      query: { limit: '1', cursor: String(rec(first.body).nextCursor) },
    });
    expect(items(second.body)).toHaveLength(1);
    expect(items(second.body)[0]?.id).not.toBe(items(first.body)[0]?.id);
  });

  it('11.1 filters by kind and status', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/catalog', {
      query: { kind: 'plugin', status: 'draft' },
    });
    expect(items(res.body).map((e) => e.id)).toEqual(['entry-plugin']);
  });

  it('11.1 a manager creates a draft entry owned by their team', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'POST', '/catalog', {
      body: { slug: 'new-one', displayName: 'New', ownerTeamId: 'team-a' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'draft',
      ownerTeamId: 'team-a',
      createdBy: 'user-manager-a',
    });
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'catalog.entry.create' });
  });

  it('10.1 a manager cannot create for another team or for the org', async () => {
    api = await buildTestApi();
    const other = await api.call('managerOwn', 'POST', '/catalog', {
      body: { slug: 'x', displayName: 'X', ownerTeamId: 'team-b' },
    });
    expect(other.status).toBe(403);
    const orgOwned = await api.call('managerOwn', 'POST', '/catalog', {
      body: { slug: 'x', displayName: 'X' },
    });
    expect(orgOwned.status).toBe(403);
    const admin = await api.call('admin', 'POST', '/catalog', {
      body: { slug: 'x', displayName: 'X' },
    });
    expect(admin.status).toBe(201);
  });

  it('11.1 rejects duplicate slugs with 409', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/catalog', {
      body: { slug: 'team-a-server', displayName: 'Dup' },
    });
    expect(res.status).toBe(409);
  });

  it('17.1 updates an entry with If-Match and rejects stale tags', async () => {
    api = await buildTestApi();
    const tag = await etagOf(api, 'managerOwn', '/catalog/entry-team-a');
    const ok = await api.call('managerOwn', 'PATCH', '/catalog/entry-team-a', {
      headers: { 'if-match': tag },
      body: { description: 'new text', risk: 'high' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ description: 'new text', risk: 'high' });
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"catalog"}');
    const stale = await api.call('managerOwn', 'PATCH', '/catalog/entry-team-a', {
      headers: { 'if-match': tag },
      body: { description: 'again' },
    });
    expect(stale.status).toBe(412);
  });

  it('11.1 only deprecated or archived are settable statuses on PATCH', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'PATCH', '/catalog/entry-team-a', {
      headers: { 'if-match': '*' },
      body: { status: 'published' },
    });
    expect(res.status).toBe(400);
  });

  it('11.1 deletes an entry with its versions and files, but not one with installations', async () => {
    api = await buildTestApi();
    await api.store.seed('installations', {
      id: 'inst-1',
      catalogEntryId: 'entry-team-b',
      ownerType: 'user',
      ownerId: 'user-member-b',
    });
    const blocked = await api.call('admin', 'DELETE', '/catalog/entry-team-b', {
      headers: { 'if-match': '*' },
    });
    expect(blocked.status).toBe(409);
    expect(rec(blocked.body).code).toBe('entry_in_use');
    const del = await api.call('admin', 'DELETE', '/catalog/entry-plugin', {
      headers: { 'if-match': '*' },
    });
    expect(del.status).toBe(204);
    expect(await api.store.get('catalog_versions', 'ver-plugin')).toBeNull();
    expect(await api.store.find('catalog_files', { catalogVersionId: 'ver-plugin' })).toHaveLength(
      0,
    );
    expect((await api.call('admin', 'GET', '/catalog/entry-plugin')).status).toBe(404);
  });
});

describe('11.1 deleting and retiring entries', () => {
  const del = (t: TestApi, actor: 'admin' | 'managerOwn', id: string) =>
    t.call(actor, 'DELETE', `/catalog/${id}`, { headers: { 'if-match': '*' } });

  it('11.1 deletes a draft that was never tested', async () => {
    api = await buildTestApi();
    const res = await del(api, 'managerOwn', 'entry-plugin');
    expect(res.status).toBe(204);
    expect(await api.store.get('catalog_entries', 'entry-plugin')).toBeNull();
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'catalog.entry.delete' });
  });

  it('11.3 deletes a tested draft: its hidden test installation does not count and is stopped and removed', async () => {
    const fake = makeFakeInstallations();
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    await api.store.seed('installations', {
      id: 'inst-test-1',
      catalogEntryId: 'entry-team-b',
      catalogVersionId: 'ver-team-b-draft',
      ownerType: 'user',
      ownerId: 'user-manager-b',
      origin: 'test',
      enabled: false,
      secretRefs: { API_KEY: { scope: 'user', name: 'inst-test-1.API_KEY', version: 1 } },
    });
    await api.secrets.put({
      scope: 'user',
      ownerId: 'user-manager-b',
      name: 'inst-test-1.API_KEY',
      value: 'x',
    });
    // the seeded team-b installation is real: drop it so only the test installation is left
    await api.store.remove('installations', 'inst-team-b');
    const res = await del(api, 'admin', 'entry-team-b');
    expect(res.status).toBe(204);
    expect(fake.calls.stop).toEqual(['inst-test-1']);
    expect(await api.store.get('installations', 'inst-test-1')).toBeNull();
    expect(await api.secrets.list({ scope: 'user', ownerId: 'user-manager-b' })).toHaveLength(0);
    expect(await api.store.find('catalog_versions', { entryId: 'entry-team-b' })).toHaveLength(0);
    expect(await api.store.get('catalog_entries', 'entry-team-b')).toBeNull();
  });

  it('11.1 deletes a published entry without installations', async () => {
    api = await buildTestApi();
    await api.store.remove('installations', 'inst-team-a');
    const res = await del(api, 'managerOwn', 'entry-team-a');
    expect(res.status).toBe(204);
    expect(await api.store.find('catalog_versions', { entryId: 'entry-team-a' })).toHaveLength(0);
  });

  it('11.1 refuses to delete an entry real installations use, with counts and guidance, and keeps test installations', async () => {
    const fake = makeFakeInstallations();
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    await api.store.seed('installations', {
      id: 'inst-test-2',
      catalogEntryId: 'entry-org',
      ownerType: 'user',
      ownerId: 'user-manager-b',
      origin: 'test',
    });
    const res = await del(api, 'admin', 'entry-org');
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('entry_in_use');
    const text = JSON.stringify(res.body);
    expect(text).toMatch(/3 installations use this entry/);
    expect(text).toMatch(
      /Deprecate it to hide it from the Store, or remove the installations first/,
    );
    expect(fake.calls.stop).toEqual([]);
    expect(await api.store.get('installations', 'inst-test-2')).not.toBeNull();
    expect(await api.store.get('catalog_entries', 'entry-org')).not.toBeNull();
  });

  it('10.1 a manager deletes entries of their own team only; members and auditors cannot', async () => {
    api = await buildTestApi();
    expect((await del(api, 'managerOwn', 'entry-team-b')).status).toBe(403);
    expect((await del(api, 'managerOwn', 'entry-org')).status).toBe(403);
    expect(
      (
        await api.call('member', 'DELETE', '/catalog/entry-plugin', {
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(403);
    expect((await del(api, 'managerOwn', 'entry-plugin')).status).toBe(204);
  });

  it('11.1 deprecates and archives a published entry with audit events; the Store hides both', async () => {
    api = await buildTestApi();
    const listed = async () =>
      items((await api?.call('member', 'GET', '/store'))?.body).map((e) => e.id);
    expect(await listed()).toContain('entry-team-a');
    const dep = await api.call('managerOwn', 'PATCH', '/catalog/entry-team-a', {
      headers: { 'if-match': '*' },
      body: { status: 'deprecated' },
    });
    expect(dep.status).toBe(200);
    expect(dep.body).toMatchObject({ status: 'deprecated' });
    expect(api.uow.audits.map((a) => a.action)).toContain('catalog.entry.deprecate');
    expect(await listed()).not.toContain('entry-team-a');
    expect((await api.call('member', 'GET', '/store/team-a-server')).status).toBe(404);
    // archiving is allowed while real installations exist (inst-team-a): it only marks the entry
    const arch = await api.call('managerOwn', 'PATCH', '/catalog/entry-team-a', {
      headers: { 'if-match': '*' },
      body: { status: 'archived' },
    });
    expect(arch.status).toBe(200);
    expect(arch.body).toMatchObject({ status: 'archived' });
    expect(api.uow.audits.map((a) => a.action)).toContain('catalog.entry.archive');
    expect(await listed()).not.toContain('entry-team-a');
  });

  it('11.1 a draft cannot be deprecated or archived, and nothing returns to published by PATCH', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'PATCH', '/catalog/entry-plugin', {
      headers: { 'if-match': '*' },
      body: { status: 'archived' },
    });
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('invalid_status');
  });
});

describe('11.1 versions', () => {
  it('11.1 lists, creates and reads versions of an entry', async () => {
    api = await buildTestApi();
    const list = await api.call('managerOwn', 'GET', '/catalog/entry-team-a/versions');
    expect(items(list.body).map((v) => v.id)).toEqual(
      expect.arrayContaining(['ver-team-a', 'ver-team-a-pub']),
    );
    const created = await api.call('managerOwn', 'POST', '/catalog/entry-team-a/versions', {
      body: { label: '3', serverSpec: REMOTE_SPEC },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', label: '3', entryId: 'entry-team-a' });
    const dup = await api.call('managerOwn', 'POST', '/catalog/entry-team-a/versions', {
      body: { label: '3', serverSpec: REMOTE_SPEC },
    });
    expect(dup.status).toBe(409);
    const got = await api.call(
      'managerOwn',
      'GET',
      `/catalog/entry-team-a/versions/${rec(created.body).id}`,
    );
    expect(got.status).toBe(200);
  });

  it('11.1 edits a draft version in place with If-Match and refuses published versions', async () => {
    api = await buildTestApi();
    const ok = await api.call('managerOwn', 'PATCH', '/catalog/entry-team-a/versions/ver-team-a', {
      headers: { 'if-match': '*' },
      body: { changelog: 'edited', serverSpec: REMOTE_SPEC },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: 'ver-team-a', status: 'draft', changelog: 'edited' });
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"catalog"}');
    const published = await api.call(
      'managerOwn',
      'PATCH',
      '/catalog/entry-team-a/versions/ver-team-a-pub',
      { headers: { 'if-match': '*' }, body: { changelog: 'nope' } },
    );
    expect(published.status).toBe(409);
    expect(published.body).toMatchObject({ code: 'version_immutable' });
    const clash = await api.call(
      'managerOwn',
      'PATCH',
      '/catalog/entry-team-a/versions/ver-team-a',
      {
        headers: { 'if-match': '*' },
        body: { label: (await api.store.get('catalog_versions', 'ver-team-a-pub'))?.label },
      },
    );
    expect(clash.status).toBe(409);
    const missing = await api.call(
      'managerOwn',
      'PATCH',
      '/catalog/entry-team-b/versions/ver-team-a',
      {
        headers: { 'if-match': '*' },
        body: { changelog: 'x' },
      },
    );
    expect([403, 404]).toContain(missing.status);
  });

  it('8.7 rejects an invalid server spec', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/catalog/entry-team-a/versions', {
      body: {
        label: '9',
        serverSpec: {
          type: 'package',
          runtime: 'npm',
          identifier: 'x',
          version: 'latest',
          auth: { mode: 'none' },
        },
      },
    });
    expect(res.status).toBe(400);
  });

  it('11.1 a version of another entry is 404', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/catalog/entry-team-a/versions/ver-team-b');
    expect(res.status).toBe(404);
  });
});

describe('11.2 automatic test', () => {
  it('11.2 starts a test run and answers 202', async () => {
    api = await buildTestApi();
    const res = await api.call(
      'managerOwn',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/test',
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ versionId: 'ver-team-a', status: 'running' });
    const tests = api.deps.catalog.tests as FakeVersionTests;
    expect(tests.started).toEqual([
      { entryId: 'entry-team-a', versionId: 'ver-team-a', requestedBy: 'user-manager-a' },
    ]);
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'catalog.version.test' });
  });

  it('11.3 the author may give values for variables without a default, which reach the test run', async () => {
    api = await buildTestApi();
    const res = await api.call(
      'managerOwn',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/test',
      { body: { variables: { DATABASE_URL: 'postgres://db/test' } } },
    );
    expect(res.status).toBe(202);
    const tests = api.deps.catalog.tests as FakeVersionTests;
    expect(tests.started.at(-1)).toMatchObject({
      versionId: 'ver-team-a',
      variables: { DATABASE_URL: 'postgres://db/test' },
    });
    const refused = await api.call(
      'managerOwn',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/test',
      { body: { variables: { X: 1 } } },
    );
    expect(refused.status).toBe(400);
  });

  it('18.1 streams the latest run and progress until the run finishes', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', '/catalog/entry-team-a/versions/ver-team-a/test');
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const address = api.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/catalog/entry-team-a/versions/ver-team-a/test`,
      {
        headers: { authorization: 'Bearer tok-admin' },
      },
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async () => {
      const chunk = await reader?.read();
      if (chunk?.value) text += decoder.decode(chunk.value);
      return chunk?.done ?? true;
    };
    await read();
    expect(text).toContain('event: run');
    api.events.publish({
      id: 'e1',
      type: 'test.progress',
      audience: { org: true },
      topic: 'ver-team-a',
      data: { status: 'passed' },
    });
    api.events.publish({
      id: 'e2',
      type: 'test.progress',
      audience: { org: true },
      topic: 'other',
      data: { status: 'failed' },
    });
    while (!(await read())) {
      /* until the server ends the stream */
    }
    expect(text).toContain('event: progress');
    expect(text).toContain('"status":"passed"');
    expect(text).not.toContain('failed');
  });

  it('18.1 ends immediately when the latest run already finished', async () => {
    api = await buildTestApi();
    const tests = api.deps.catalog.tests as FakeVersionTests;
    tests.runs.set('ver-team-a', {
      id: 'run-9',
      versionId: 'ver-team-a',
      status: 'passed',
      steps: [],
      startedAt: 'x',
      finishedAt: 'y',
    });
    const res = await api.call('admin', 'GET', '/catalog/entry-team-a/versions/ver-team-a/test');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('event: run');
  });
});

describe('11.1 publishing', () => {
  it('11.1 publishes a tested draft: version published, entry current version updated', async () => {
    api = await buildTestApi();
    const res = await api.call(
      'managerOwn',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/publish',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'published' });
    const entry = await api.store.get('catalog_entries', 'entry-team-a');
    expect(entry?.currentVersionId).toBe('ver-team-a');
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"catalog"}');
    expect(api.uow.audits.at(-1)).toMatchObject({
      action: 'catalog.version.publish',
      targetId: 'ver-team-a',
    });
  });

  it('11.2 refuses to publish an untested version', async () => {
    api = await buildTestApi();
    const res = await api.call(
      'admin',
      'POST',
      '/catalog/entry-team-b/versions/ver-team-b-draft/publish',
    );
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('test_required');
  });

  it('11.1 published versions are immutable: publishing again is 409', async () => {
    api = await buildTestApi();
    const res = await api.call(
      'admin',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a-pub/publish',
    );
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('version_immutable');
  });

  it('10.1 org-wide publishing needs an admin or an org-wide publisher', async () => {
    api = await buildTestApi();
    const body = { visibility: { org: true } };
    const manager = await api.call(
      'managerOwn',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/publish',
      { body },
    );
    expect(manager.status).toBe(403);
    await api.store.update('users', 'user-manager-a', { catalogPublishOrgWide: true });
    const publisher = await api.call(
      'managerOwn',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/publish',
      { body },
    );
    expect(publisher.status).toBe(200);
    expect((await api.store.get('catalog_entries', 'entry-team-a'))?.visibility).toMatchObject({
      org: true,
    });
  });

  it('10.1 a manager cannot publish another team’s entry', async () => {
    api = await buildTestApi();
    const res = await api.call(
      'managerOther',
      'POST',
      '/catalog/entry-team-a/versions/ver-team-a/publish',
    );
    expect(res.status).toBe(403);
  });
});

describe('25.2 files and executable approval', () => {
  const url = '/catalog/entry-plugin/versions/ver-plugin';

  it('25.2 lists files with classification and the approval state', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'GET', `${url}/files`);
    expect(res.status).toBe(200);
    const byPath = Object.fromEntries(
      items(res.body).map((f) => [String(f.path), f.classification]),
    );
    expect(byPath).toEqual({ 'SKILL.md': 'plain', 'scripts/run.sh': 'executable' });
    expect(rec(rec(res.body).approval).status).toBe('pending');
  });

  it('25.2 reads a file with URL-encoded slashes in the path', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'GET', `${url}/files/scripts%2Frun.sh`);
    expect(res.status).toBe(200);
    expect(Buffer.from(String(rec(res.body).contentBase64), 'base64').toString()).toBe(
      SEED_FILES['scripts/run.sh'],
    );
    expect((await api.call('managerOwn', 'GET', `${url}/files/nope.md`)).status).toBe(404);
  });

  it('25.2 rejects traversal paths', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'PUT', `${url}/files/..%2Fevil.sh`, {
      body: { contentBase64: b64('x') },
    });
    expect(res.status).toBe(422);
  });

  it('25.2 puts a new file, classifies it and stores its blob', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'PUT', `${url}/files/docs%2Freadme.md`, {
      body: { contentBase64: b64('# hi') },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      path: 'docs/readme.md',
      classification: 'plain',
      sha256: sha256Hex('# hi'),
    });
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'catalog.file.put' });
  });

  it('25.2 a shebang file is executable; replacing needs If-Match', async () => {
    api = await buildTestApi();
    const created = await api.call('managerOwn', 'PUT', `${url}/files/bin%2Ftool`, {
      body: { contentBase64: b64('#!/bin/sh\n') },
    });
    expect(created.body).toMatchObject({ classification: 'executable' });
    const again = await api.call('managerOwn', 'PUT', `${url}/files/bin%2Ftool`, {
      body: { contentBase64: b64('#!/bin/sh\necho\n') },
    });
    expect(again.status).toBe(428);
    const ok = await api.call('managerOwn', 'PUT', `${url}/files/bin%2Ftool`, {
      headers: { 'if-match': `"${String(rec(created.body).updatedAt)}"` },
      body: { contentBase64: b64('#!/bin/sh\necho\n') },
    });
    expect(ok.status).toBe(200);
  });

  it('25.2 rejects invalid base64 and oversize files', async () => {
    api = await buildTestApi();
    const bad = await api.call('managerOwn', 'PUT', `${url}/files/a.md`, {
      body: { contentBase64: '%%%' },
    });
    expect(bad.status).toBe(400);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const huge = await api.call('managerOwn', 'PUT', `${url}/files/big.bin`, {
      body: { contentBase64: big },
    });
    expect(huge.status).toBe(413);
  });

  it('11.1 deletes a file; published versions refuse file edits', async () => {
    api = await buildTestApi();
    const del = await api.call('managerOwn', 'DELETE', `${url}/files/SKILL.md`, {
      headers: { 'if-match': '*' },
    });
    expect(del.status).toBe(204);
    expect(
      (
        await api.call('managerOwn', 'DELETE', `${url}/files/SKILL.md`, {
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(404);
    const pub = await api.call(
      'admin',
      'PUT',
      '/catalog/entry-team-a/versions/ver-team-a-pub/files/a.md',
      {
        body: { contentBase64: b64('x') },
      },
    );
    expect(pub.status).toBe(409);
    expect(rec(pub.body).code).toBe('version_immutable');
  });

  it('25.2 admin approves the executable content; a manager cannot', async () => {
    api = await buildTestApi();
    const denied = await api.call('managerOwn', 'POST', `${url}/approve-executable`);
    expect(denied.status).toBe(403);
    const files = await api.call('admin', 'GET', `${url}/files`);
    const digest = String(rec(rec(files.body).approval).reviewedDiffSha256);
    const ok = await api.call('admin', 'POST', `${url}/approve-executable`, {
      body: { note: 'reviewed', reviewedDiffSha256: digest },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      approvedBy: 'user-admin',
      reviewedDiffSha256: digest,
    });
    const after = await api.call('admin', 'GET', `${url}/files`);
    expect(rec(rec(after.body).approval).status).toBe('approved');
    const version = await api.call('admin', 'GET', url);
    expect(rec(version.body).approval).toMatchObject({ status: 'approved' });
  });

  it('25.2 an approval bound to a stale digest is refused (409)', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', `${url}/approve-executable`, {
      body: { reviewedDiffSha256: 'a'.repeat(64) },
    });
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('stale_review');
  });

  it('25.2 editing a file revokes the approval', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', `${url}/approve-executable`);
    expect(await api.store.get('executable_approvals', 'ver-plugin')).not.toBeNull();
    await api.call('admin', 'PUT', `${url}/files/notes.md`, { body: { contentBase64: b64('n') } });
    expect(await api.store.get('executable_approvals', 'ver-plugin')).toBeNull();
  });

  it('25.2 plain versions need no approval', async () => {
    api = await buildTestApi();
    await api.call('admin', 'DELETE', `${url}/files/scripts%2Frun.sh`, {
      headers: { 'if-match': '*' },
    });
    const res = await api.call('admin', 'POST', `${url}/approve-executable`);
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('approval_not_required');
  });

  it('10.1 publishing a plugin with executable content needs the approval first', async () => {
    api = await buildTestApi();
    const blocked = await api.call('admin', 'POST', `${url}/publish`);
    expect(blocked.status).toBe(409);
    expect(rec(blocked.body).code).toBe('approval_required');
    await api.call('admin', 'POST', `${url}/approve-executable`);
    const ok = await api.call('admin', 'POST', `${url}/publish`);
    expect(ok.status).toBe(200);
  });

  it('25.2 a new version is reviewed against the previously approved one', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', `${url}/approve-executable`);
    await api.call('admin', 'POST', `${url}/publish`);
    const next = await api.call('admin', 'POST', '/catalog/entry-plugin/versions', {
      body: { label: '1.1.0' },
    });
    const nextId = String(rec(next.body).id);
    for (const [path, text, mode] of [
      ['SKILL.md', SEED_FILES['SKILL.md'], 'file'],
      ['scripts/run.sh', SEED_FILES['scripts/run.sh'], 'executable'],
    ] as const) {
      await api.call(
        'admin',
        'PUT',
        `/catalog/entry-plugin/versions/${nextId}/files/${encodeURIComponent(path)}`,
        {
          body: { contentBase64: b64(text), mode },
        },
      );
    }
    const files = await api.call('admin', 'GET', `/catalog/entry-plugin/versions/${nextId}/files`);
    const approval = rec(rec(files.body).approval);
    expect(approval.status).toBe('pending');
    expect(approval.diff).toEqual([]);
  });
});

describe('11.3 import', () => {
  const serverJson = {
    name: 'io.example/weather',
    description: 'Weather',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://weather.example.com/mcp' }],
  };

  it('11.3 imports server.json into a draft entry and version', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/catalog/import', {
      body: { source: { kind: 'server_json', serverJson } },
    });
    expect(res.status).toBe(201);
    const body = rec(res.body);
    expect(body.entry).toMatchObject({
      slug: 'weather',
      status: 'draft',
      kind: 'mcp_server',
      ownerTeamId: null,
    });
    expect(body.version).toMatchObject({ status: 'draft', label: '1.0.0' });
    expect(rec(rec(body.version).serverSpec).type).toBe('remote');
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'catalog.import' });
  });

  it('11.3 accepts server.json as text and suffixes a taken slug', async () => {
    api = await buildTestApi();
    const first = await api.call('admin', 'POST', '/catalog/import', {
      body: { source: { kind: 'server_json', serverJson: JSON.stringify(serverJson) } },
    });
    const second = await api.call('admin', 'POST', '/catalog/import', {
      body: { source: { kind: 'server_json', serverJson } },
    });
    expect(rec(rec(first.body).entry).slug).toBe('weather');
    expect(rec(rec(second.body).entry).slug).toBe('weather-2');
  });

  it('11.3 rejects an invalid or unsupported server.json with 422', async () => {
    api = await buildTestApi();
    const bad = await api.call('admin', 'POST', '/catalog/import', {
      body: { source: { kind: 'server_json', serverJson: { name: 'x' } } },
    });
    expect(bad.status).toBe(422);
    const none = await api.call('admin', 'POST', '/catalog/import', {
      body: {
        source: {
          kind: 'server_json',
          serverJson: { name: 'a/b', description: 'd', version: '1.0.0' },
        },
      },
    });
    expect(none.status).toBe(422);
  });

  it('11.3 imports a client config snippet resolving the exact version', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/catalog/import', {
      body: {
        ownerTeamId: 'team-a',
        source: {
          kind: 'client_config',
          snippet: { command: 'npx', args: ['-y', '@acme/mcp-thing'] },
          name: 'Thing',
        },
      },
    });
    expect(res.status).toBe(201);
    expect(rec(res.body).entry).toMatchObject({ displayName: 'Thing', ownerTeamId: 'team-a' });
    expect(rec(rec(rec(res.body).version).serverSpec).version).toBe('1.2.3');
  });

  it('11.3 imports a registry reference with risk from source trust', async () => {
    api = await buildTestApi({
      overrides: {
        registry: {
          sources: { get: async () => ({ id: 's1', trust: 'official' }) },
          servers: { list: async () => [{ version: '1.0.0', serverJson }] },
        } as unknown as ApiDeps['registry'],
      },
    });
    const res = await api.call('admin', 'POST', '/catalog/import', {
      body: {
        source: { kind: 'registry', sourceId: 's1', name: 'io.example/weather', version: '1.0.0' },
      },
    });
    expect(res.status).toBe(201);
    expect(rec(res.body).entry).toMatchObject({
      risk: 'low',
      source: {
        kind: 'registry',
        registrySourceId: 's1',
        serverName: 'io.example/weather',
        version: '1.0.0',
      },
    });
    const missing = await api.call('admin', 'POST', '/catalog/import', {
      body: {
        source: { kind: 'registry', sourceId: 's1', name: 'io.example/weather', version: '9.9.9' },
      },
    });
    expect(missing.status).toBe(404);
  });

  it('11.3 registry import with an unknown source is 404', async () => {
    api = await buildTestApi({
      overrides: {
        registry: { sources: { get: async () => null } } as unknown as ApiDeps['registry'],
      },
    });
    const res = await api.call('admin', 'POST', '/catalog/import', {
      body: { source: { kind: 'registry', sourceId: 'zz', name: 'a/b', version: '1' } },
    });
    expect(res.status).toBe(404);
  });

  it('25.2 imports a zip upload as a skill draft with classified files', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'POST', '/catalog/import', {
      body: { ownerTeamId: 'team-a', source: { kind: 'zip', contentBase64: b64('PK') } },
    });
    expect(res.status).toBe(201);
    expect(rec(res.body).entry).toMatchObject({ kind: 'skill', displayName: 'Zip Skill' });
    const files = await api.store.find('catalog_files', {
      catalogVersionId: String(rec(rec(res.body).version).id),
    });
    expect(files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect((api.deps.catalog.imports as FakeImports).zipDraft.kind).toBe('skill');
  });

  it('25.2 imports a git URL; hook files are classified executable and warnings returned', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/catalog/import', {
      body: { source: { kind: 'git', url: 'https://git.example.com/p.git', ref: 'main' } },
    });
    expect(res.status).toBe(201);
    expect(rec(res.body).warnings).toEqual(['one warning']);
    expect(rec(rec(res.body).entry).source).toMatchObject({
      kind: 'git',
      url: 'https://git.example.com/p.git',
      ref: 'main',
    });
    const files = await api.store.find('catalog_files', {
      catalogVersionId: String(rec(rec(res.body).version).id),
    });
    expect(Object.fromEntries(files.map((f) => [f.path, f.classification]))).toEqual({
      'SKILL.md': 'plain',
      'hooks/hooks.json': 'executable',
    });
  });

  it('10.1 a manager imports only into their own team', async () => {
    api = await buildTestApi();
    const body = { source: { kind: 'server_json', serverJson } };
    expect((await api.call('managerOwn', 'POST', '/catalog/import', { body })).status).toBe(403);
    expect(
      (
        await api.call('managerOwn', 'POST', '/catalog/import', {
          body: { ...body, ownerTeamId: 'team-b' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call('managerOwn', 'POST', '/catalog/import', {
          body: { ...body, ownerTeamId: 'team-a' },
        })
      ).status,
    ).toBe(201);
  });
});

describe('11.1 store', () => {
  it('11.1 lists published entries the caller may install', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/store');
    const slugs = items(res.body).map((e) => e.slug);
    expect(slugs).toEqual(expect.arrayContaining(['team-a-server', 'org-server']));
    expect(slugs).not.toContain('team-b-server');
    expect(slugs).not.toContain('demo-plugin');
  });

  it('11.1 shows an entry with its current version; hidden entries are 404', async () => {
    api = await buildTestApi();
    const ok = await api.call('member', 'GET', '/store/team-a-server');
    expect(ok.status).toBe(200);
    expect(rec(ok.body).version).toMatchObject({ id: 'ver-team-a-pub', label: '1' });
    expect((await api.call('member', 'GET', '/store/team-b-server')).status).toBe(404);
    expect((await api.call('member', 'GET', '/store/demo-plugin')).status).toBe(404);
    expect((await api.call('admin', 'GET', '/store/team-b-server')).status).toBe(200);
  });

  it('11.1 text search and kind filter apply to the store', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/store', {
      query: { q: 'org-server', kind: 'mcp_server' },
    });
    expect(items(res.body)).toHaveLength(1);
  });
});

describe('25.2 plugin sources', () => {
  it('25.2 lists, creates, updates and deletes plugin sources', async () => {
    api = await buildTestApi();
    expect(items((await api.call('admin', 'GET', '/plugin-sources')).body)).toHaveLength(1);
    const created = await api.call('admin', 'POST', '/plugin-sources', {
      body: { name: 'More', gitUrl: 'https://git.example.com/more.git' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ref: 'main', tracked: true });
    const id = String(rec(created.body).id);
    const patched = await api.call('admin', 'PATCH', `/plugin-sources/${id}`, {
      headers: { 'if-match': String(created.headers.etag) },
      body: { ref: 'v2' },
    });
    expect(patched.body).toMatchObject({ ref: 'v2' });
    const del = await api.call('admin', 'DELETE', `/plugin-sources/${id}`, {
      headers: { 'if-match': '*' },
    });
    expect(del.status).toBe(204);
  });

  it('22 rejects non-https git URLs', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/plugin-sources', {
      body: { name: 'x', gitUrl: 'http://git.example.com/x.git' },
    });
    expect(res.status).toBe(400);
  });

  it('25.2 syncs a source and records the result', async () => {
    api = await buildTestApi({
      overrides: {
        plugins: {
          syncSource: async () => ({ imported: 2, updated: 1, errors: [] }),
        } as unknown as ApiDeps['plugins'],
      },
    });
    const res = await api.call('admin', 'POST', '/plugin-sources/psrc-1/sync');
    expect(res.status).toBe(200);
    expect(rec(res.body).lastSync).toMatchObject({ imported: 2, updated: 1, ok: true });
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'plugin_source.sync' });
    expect((await api.call('admin', 'POST', '/plugin-sources/nope/sync')).status).toBe(404);
  });

  it('10.1 managers cannot manage plugin sources but can read them? no: only admins and auditors read', async () => {
    api = await buildTestApi();
    expect(
      (
        await api.call('managerOwn', 'POST', '/plugin-sources', {
          body: { name: 'x', gitUrl: 'https://a.example.com/x.git' },
        })
      ).status,
    ).toBe(403);
    expect((await api.call('member', 'GET', '/plugin-sources')).status).toBe(403);
    expect((await api.call('auditor', 'GET', '/plugin-sources')).status).toBe(200);
  });
});

describe('10 catalog authorization before data access', () => {
  it('10 a member cannot read an entry they cannot see, even a missing one leaks nothing', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'GET', '/catalog/entry-team-b')).status).toBe(403);
    expect((await api.call('member', 'GET', '/catalog/missing')).status).toBe(403);
    expect((await api.call('admin', 'GET', '/catalog/missing')).status).toBe(404);
  });
});
