import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@bastion-mcp/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractCredential, importFromGit, importZip, ReleaseService } from '../src';
import { asResolved, plainItem, sampleItems } from './helpers/items';
import { basic, createWorld, type World } from './helpers/world';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const get = (world: World, path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  world.handler(new Request(`https://mcp.example.com${path}`, { headers, ...init }));

let world: World;
beforeEach(async () => {
  world = await createWorld();
});
afterEach(async () => {
  await world.close();
});

describe('25.4 releases', () => {
  it('25.4 every change creates an immutable numbered release; unchanged content creates none', async () => {
    const first = await world.service.publish(world.marketplace.id, 'admin-1');
    expect(first).toMatchObject({ created: true, record: { seq: 1 } });
    expect((await world.service.publish(world.marketplace.id)).created).toBe(false);
    world.marketplaces.current = asResolved([...sampleItems(), { ...plainItem(), name: 'extra', manifest: { ...plainItem().manifest, name: 'extra' } }]);
    const second = await world.service.publish(world.marketplace.id);
    expect(second).toMatchObject({ created: true, record: { seq: 2 } });
    expect(second.record.gitCommit).not.toBe(first.record.gitCommit);
    await expect(
      world.releases.insert(world.marketplace.id, first.record, [], null),
    ).rejects.toThrow(/immutable/);
  });

  it('25.4 an admin can promote a release; unknown releases are rejected', async () => {
    await world.service.publish(world.marketplace.id);
    await world.service.promote(world.marketplace.id, 1);
    expect((await world.marketplaces.getById(world.marketplace.id))?.promotedRelease).toBe(1);
    await expect(world.service.promote(world.marketplace.id, 9)).rejects.toThrow(/not found/);
    await expect(world.service.publish('missing')).rejects.toThrow(/not found/);
  });

  it('23.2 serving rebuilds a release and verifies it against the recorded digests', async () => {
    const { record } = await world.service.publish(world.marketplace.id);
    const built = await world.service.getBuilt(world.marketplace, record);
    expect(built.record).toEqual(record);
    expect(await world.service.getBuilt(world.marketplace, record)).toBe(built); // memoized
    const tampered = { ...record, agentsManifestSha256: 'f'.repeat(64) };
    const other = new ReleaseService({
      host: 'mcp.example.com',
      marketplaces: world.marketplaces,
      releases: world.releases,
    });
    await expect(other.getBuilt(world.marketplace, tampered)).rejects.toThrow(/does not rebuild/);
  });
});

describe('25.5 channel authentication and audience', () => {
  beforeEach(async () => {
    await world.service.publish(world.marketplace.id);
  });

  it('25.5 answers 401 with WWW-Authenticate Basic realm "Bastion plugins" without credentials', async () => {
    for (const path of ['/plugins/acme-tools.git/info/refs?service=git-upload-pack', '/plugins/acme-tools/marketplace.json', '/plugins/acme-tools/archives/notes-1.0.0.zip']) {
      const res = await get(world, path);
      expect(res?.status, path).toBe(401);
      expect(res?.headers.get('www-authenticate')).toBe('Basic realm="Bastion plugins"');
    }
    const bad = await get(world, '/plugins/acme-tools/marketplace.json', { authorization: 'Bearer nope' });
    expect(bad?.status).toBe(401);
    const noPassword = await get(world, '/plugins/acme-tools/marketplace.json', { authorization: `Basic ${Buffer.from('user:').toString('base64')}` });
    expect(noPassword?.status).toBe(401);
    expect((await get(world, '/plugins/acme-tools/marketplace.json', { authorization: 'Digest x' }))?.status).toBe(401);
  });

  it('9.3 requires the plugins:read scope', async () => {
    const res = await get(world, '/plugins/acme-tools/marketplace.json', { authorization: 'Bearer wrong-scope' });
    expect(res?.status).toBe(403);
  });

  it('25.4 returns 404 outside the audience and for unknown marketplaces on every channel', async () => {
    const auth = { authorization: basic('outsider') };
    for (const path of [
      '/plugins/acme-tools/marketplace.json',
      '/plugins/acme-tools/archives/notes-1.0.0.zip',
      '/plugins/acme-tools.git/info/refs?service=git-upload-pack',
      '/plugins/nope/marketplace.json',
    ]) {
      expect((await get(world, path, auth))?.status, path).toBe(404);
    }
    expect((await get(world, '/plugins/nope/marketplace.json', { authorization: 'Bearer good-token' }))?.status).toBe(404);
  });

  it('25.5 ignores paths it does not own', async () => {
    expect(await get(world, '/api/v1/me')).toBeUndefined();
    expect(await get(world, '/plugins/Bad_Slug/marketplace.json')).toBeUndefined();
  });

  it('25.5 accepts Bearer and Basic credentials (any username)', () => {
    expect(extractCredential('Bearer abc')).toBe('abc');
    expect(extractCredential(`Basic ${Buffer.from('x-access-token:secret').toString('base64')}`)).toBe('secret');
    expect(extractCredential(`Basic ${Buffer.from('only-user').toString('base64')}`)).toBeUndefined();
    expect(extractCredential(null)).toBeUndefined();
    expect(extractCredential('Bearer')).toBeUndefined();
  });
});

describe('25.5 HTTPS channel', () => {
  beforeEach(async () => {
    await world.service.publish(world.marketplace.id);
    world.marketplaces.current = asResolved(sampleItems().slice(0, 2));
    await world.service.publish(world.marketplace.id);
  });
  const auth = { authorization: 'Bearer good-token' };

  it('25.5 serves the latest Claude manifest with archive sources and sha256', async () => {
    const res = await get(world, '/plugins/acme-tools/marketplace.json', auth);
    expect(res?.status).toBe(200);
    expect(res?.headers.get('x-bastion-release')).toBe('2');
    const manifest = (await res?.json()) as { plugins: { name: string; source: { source: string; url: string; sha256: string } }[] };
    expect(manifest.plugins.map((p) => p.name)).toEqual(['code-review', 'toolbox']);
    const source = manifest.plugins[0]?.source;
    expect(source).toMatchObject({ source: 'archive', url: 'https://mcp.example.com/plugins/acme-tools/archives/code-review-1.2.0.zip' });
    expect(source?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('25.5 ?release=N serves that release', async () => {
    const one = (await (await get(world, '/plugins/acme-tools/marketplace.json?release=1', auth))?.json()) as { plugins: unknown[] };
    expect(one.plugins).toHaveLength(3);
    expect((await get(world, '/plugins/acme-tools/marketplace.json?release=7', auth))?.status).toBe(404);
    expect((await get(world, '/plugins/acme-tools/marketplace.json?release=abc', auth))?.status).toBe(400);
  });

  it('25.5 archives verify against the manifest sha256 and unzip with the plugin at the root', async () => {
    const manifest = (await (await get(world, '/plugins/acme-tools/marketplace.json', auth))?.json()) as { plugins: { name: string; source: { url: string; sha256: string } }[] };
    for (const plugin of manifest.plugins) {
      const path = new URL(plugin.source.url).pathname;
      const res = await get(world, path, auth);
      expect(res?.status).toBe(200);
      expect(res?.headers.get('content-type')).toBe('application/zip');
      const bytes = new Uint8Array(await (res as Response).arrayBuffer());
      expect(sha256Hex(bytes)).toBe(plugin.source.sha256);
      expect(importZip(bytes, { stripWrapper: false }).map((f) => f.path)).toContain('.claude-plugin/plugin.json');
    }
    expect((await get(world, '/plugins/acme-tools/archives/notes-1.0.0.zip', auth))?.status).toBe(404); // not in release 2
    expect((await get(world, '/plugins/acme-tools/archives/notes-1.0.0.zip?release=1', auth))?.status).toBe(200);
    expect((await get(world, '/plugins/acme-tools/archives/ghost-9.9.9.zip', auth))?.status).toBe(404);
  });

  it('25.5 rejects methods other than GET and HEAD', async () => {
    expect((await get(world, '/plugins/acme-tools/marketplace.json', auth, { method: 'POST', body: 'x' }))?.status).toBe(405);
  });

  it('25.9 records manifest fetches and archive downloads with principal, marketplace, release and user agent', async () => {
    await get(world, '/plugins/acme-tools/marketplace.json', { ...auth, 'user-agent': 'claude-cli/2.1' });
    await get(world, '/plugins/acme-tools/archives/toolbox-0.3.1.zip', { ...auth, 'user-agent': 'Claude Desktop/1' });
    expect(world.events.events.map((e) => [e.action, e.channel, e.principalId, e.marketplaceId, e.releaseSeq, e.userAgent])).toEqual([
      ['manifest_fetch', 'https', 'user-1', world.marketplace.id, 2, 'claude-cli/2.1'],
      ['archive_download', 'https', 'user-1', world.marketplace.id, 2, 'Claude Desktop/1'],
    ]);
  });

  it('25.9 a failing event sink never blocks a fetch', async () => {
    world.events.record = async () => {
      throw new Error('db down');
    };
    expect((await get(world, '/plugins/acme-tools/marketplace.json', auth))?.status).toBe(200);
  });
});

describe('25.5 git channel: read-only smart HTTP', () => {
  beforeEach(async () => {
    await world.service.publish(world.marketplace.id);
  });
  const auth = { authorization: 'Bearer good-token' };

  it.skipIf(!hasGit)('25.5 refuses receive-pack, the dumb protocol and wrong methods', async () => {
    expect((await get(world, '/plugins/acme-tools.git/info/refs?service=git-receive-pack', auth))?.status).toBe(403);
    expect((await get(world, '/plugins/acme-tools.git/git-receive-pack', auth, { method: 'POST', body: '0000' }))?.status).toBe(404);
    for (const p of ['/HEAD', '/info/refs', '/objects/info/packs', '/refs/heads/main']) {
      expect((await get(world, `/plugins/acme-tools.git${p}`, auth))?.status, p).toBe(404);
    }
    expect((await get(world, '/plugins/acme-tools.git/info/refs?service=git-upload-pack', auth, { method: 'POST', body: 'x' }))?.status).toBe(405);
    expect((await get(world, '/plugins/acme-tools.git/git-upload-pack', auth))?.status).toBe(405);
    expect((await get(world, '/plugins/acme-tools.git/info/refs?service=other', auth))?.status).toBe(404);
  });

  it('25.5 answers 404 before the first release exists', async () => {
    const fresh = await createWorld();
    try {
      expect((await get(fresh, '/plugins/acme-tools.git/info/refs?service=git-upload-pack', auth))?.status).toBe(404);
    } finally {
      await fresh.close();
    }
  });

  it.skipIf(!hasGit)('23.2 git clone with the credential gets the release commit, tags and exec bits', async () => {
    const base = await world.listen();
    const work = await mkdtemp(join(tmpdir(), 'bastion-clone-'));
    try {
      // Async: the server runs in this process, a blocking exec would deadlock it.
      const git = async (args: string[], cwd = work): Promise<string> =>
        (
          await promisify(execFile)('git', ['-c', 'credential.helper=', ...args], {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
            timeout: 60_000,
          })
        ).stdout;
      const record = await world.releases.latest(world.marketplace.id);
      const url = `${base.replace('http://', 'http://x-access-token:good-token@')}/plugins/acme-tools.git`;
      await git(['clone', url, 'clone']);
      const clone = join(work, 'clone');
      expect((await git(['rev-parse', 'HEAD'], clone)).trim()).toBe(record?.gitCommit);
      expect((await git(['tag', '--list'], clone)).trim()).toBe('release-1');
      expect(existsSync(join(clone, '.claude-plugin', 'marketplace.json'))).toBe(true);
      expect(readFileSync(join(clone, 'plugins', 'notes', 'plugin.json'), 'utf8')).toContain('"name": "notes"');
      expect(await git(['ls-tree', '-r', 'HEAD', '--', 'plugins/toolbox/skills/lint/scripts/run.sh'], clone)).toMatch(/^100755/);

      // Without credentials the clone is refused (401), with a wrong token as well.
      await expect(git(['clone', `${base}/plugins/acme-tools.git`, 'anon'])).rejects.toThrow();
      await expect(git(['clone', url.replace('good-token', 'bad'), 'bad'])).rejects.toThrow();
      // Outside the audience: not found.
      await expect(git(['clone', url.replace('good-token', 'outsider'), 'out'])).rejects.toThrow(/not found|404/i);
      // Read-only: pushes are refused.
      await git(['config', 'user.email', 'a@b.c'], clone);
      await git(['config', 'user.name', 'a'], clone);
      await git(['commit', '--allow-empty', '-m', 'x'], clone);
      await expect(git(['push', 'origin', 'HEAD:main'], clone)).rejects.toThrow();

      // A new release moves main; fetching again is a fast-forward and tags stay stable.
      world.marketplaces.current = asResolved(sampleItems().slice(0, 1));
      const second = await world.service.publish(world.marketplace.id);
      await git(['fetch', 'origin', '--tags'], clone);
      expect((await git(['rev-parse', 'origin/main'], clone)).trim()).toBe(second.record.gitCommit);
      expect((await git(['rev-parse', 'release-1'], clone)).trim()).toBe(record?.gitCommit);
      expect((await git(['rev-parse', 'release-2^'], clone)).trim()).toBe(record?.gitCommit);
      expect(world.events.events.filter((e) => e.action === 'git_fetch').length).toBeGreaterThanOrEqual(2);
      expect(world.events.events.find((e) => e.action === 'git_fetch')?.channel).toBe('git');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!hasGit)('25.3 importFromGit (isomorphic-git) reads a marketplace through the Bastion git channel', async () => {
    const base = await world.listen();
    const result = await importFromGit({
      url: `${base}/plugins/acme-tools.git`,
      ref: 'main',
      username: 'x-access-token',
      password: 'good-token',
    });
    const record = await world.releases.latest(world.marketplace.id);
    expect(result.commit).toBe(record?.gitCommit);
    expect(result.files.some((f) => f.path === '.claude-plugin/marketplace.json')).toBe(true);
    await expect(
      importFromGit({ url: `${base}/plugins/acme-tools.git`, ref: 'main', password: 'bad' }),
    ).rejects.toThrow();
  }, 60_000);

  it.skipIf(!hasGit)('25.5 builds the repository once per release and reuses it (cache layout)', async () => {
    const handle = await world.repositories.ensure(world.marketplace, 1);
    expect(handle.root).toBe(join(world.cacheDir, 'acme-tools', 'r1'));
    const again = await world.repositories.ensure(world.marketplace, 1);
    expect(again).toEqual(handle);
    world.marketplaces.current = asResolved(sampleItems().slice(0, 1));
    await world.service.publish(world.marketplace.id);
    const second = await world.repositories.ensure(world.marketplace, 2);
    expect(existsSync(join(second.gitdir, 'refs', 'tags', 'release-1'))).toBe(true);
    await expect(world.repositories.ensure(world.marketplace, 9)).rejects.toThrow(/not found/);
    // concurrent first requests share one build
    const [a, b] = await Promise.all([world.repositories.ensure(world.marketplace, 2), world.repositories.ensure(world.marketplace, 2)]);
    expect(a.commit).toBe(b.commit);
  });
});
