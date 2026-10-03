import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginStateError, rebuildRelease, runHttpBackend } from '../src';
import { createWorld, HOST, type World } from './helpers/world';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let world: World;
beforeEach(async () => {
  world = await createWorld();
});
afterEach(async () => {
  await world.close();
});

describe.skipIf(!hasGit)('25.5 http-backend and git cache', () => {
  it('25.5 maps CGI headers to a Response and advertises upload-pack only', async () => {
    const { record } = await world.service.publish(world.marketplace.id);
    const repo = await world.repositories.ensure(world.marketplace, record.seq);
    const request = {
      root: repo.root,
      pathInfo: '/repo.git/info/refs',
      method: 'GET',
      contentType: null,
      contentEncoding: null,
      gitProtocol: null,
      body: new Uint8Array(),
    };
    const ok = await runHttpBackend({ ...request, query: 'service=git-upload-pack' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    expect(await ok.text()).toContain(record.gitCommit);
    const denied = await runHttpBackend({ ...request, query: 'service=git-receive-pack' });
    expect(denied.status).toBe(403);
  });

  it('25.5 the cache builds each release once, dedupes concurrent calls and marks it complete', async () => {
    const { record } = await world.service.publish(world.marketplace.id);
    const [a, b] = await Promise.all([
      world.repositories.ensure(world.marketplace, record.seq),
      world.repositories.ensure(world.marketplace, record.seq),
    ]);
    expect(b).toBe(a);
    expect(a.commit).toBe(record.gitCommit);
    expect(await readdir(a.root)).toContain('.complete');
    const again = await world.repositories.ensure(world.marketplace, record.seq);
    expect(again.root).toBe(a.root);
    expect(await readdir(join(world.cacheDir, world.marketplace.slug))).toEqual(['r1']);
  });

  it('25.5 the cache refuses an unknown release', async () => {
    await expect(world.repositories.ensure(world.marketplace, 7)).rejects.toBeInstanceOf(
      PluginStateError,
    );
  });
});

describe('23.2 rebuildRelease', () => {
  it('23.2 rebuilds a recorded release identically and rejects a tampered archive digest', async () => {
    const { record } = await world.service.publish(world.marketplace.id);
    const items = await world.marketplaces.loadReleaseItems(world.marketplace.id, record.seq);
    const input = { host: HOST, marketplace: world.marketplace, record, items };
    expect((await rebuildRelease(input)).record).toEqual(record);
    const tampered = { ...record, gitCommit: 'a'.repeat(40) };
    await expect(rebuildRelease({ ...input, record: tampered })).rejects.toMatchObject({
      code: 'RELEASE_NOT_REPRODUCIBLE',
    });
  });
});
