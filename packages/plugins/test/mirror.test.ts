import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backoffMs,
  createGitBinaryProvider,
  type GitProvider,
  idleMirrorState,
  isMirrorPushDue,
  MIRROR_BACKOFF_MINUTES,
  MirrorPusher,
  type MirrorPushResult,
  type MirrorState,
  type MirrorTarget,
} from '../src';
import { asResolved, sampleItems } from './helpers/items';
import { createWorld, type World } from './helpers/world';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const target: MirrorTarget = {
  provider: 'github',
  repo: 'acme/mirror',
  branch: 'main',
  credentialSecretId: 's1',
};

describe('25.5 mirror backoff', () => {
  it('25.5 retries after 1, 5, 15 and 60 minutes, then every 60 minutes', () => {
    expect(MIRROR_BACKOFF_MINUTES).toEqual([1, 5, 15, 60]);
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 60_000)).toEqual([1, 5, 15, 60, 60, 60]);
    expect(backoffMs(0) / 60_000).toBe(1);
  });

  it('25.5 a mirror is not due while retrying before nextAttemptAt, and never when diverged', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const base = idleMirrorState(now);
    expect(isMirrorPushDue(base, now)).toBe(true);
    const retrying: MirrorState = {
      ...base,
      status: 'retrying',
      nextAttemptAt: '2026-10-01T12:05:00Z',
    };
    expect(isMirrorPushDue(retrying, now)).toBe(false);
    expect(isMirrorPushDue(retrying, new Date('2026-10-01T12:05:00Z'))).toBe(true);
    expect(isMirrorPushDue({ ...base, status: 'diverged' }, new Date('2030-01-01'))).toBe(false);
  });
});

describe('25.5 MirrorPusher', () => {
  let world: World;
  let pushes: { commit: string; tags: string[] }[];
  let remoteHead: string | null;
  let nextResult: () => MirrorPushResult | Error;
  let provider: GitProvider;
  let pusher: MirrorPusher;
  let tokens: string[];

  beforeEach(async () => {
    world = await createWorld();
    world.marketplaces.add({ ...world.marketplace, mirror: target });
    await world.service.publish(world.marketplace.id);
    pushes = [];
    tokens = [];
    remoteHead = null;
    nextResult = () => ({ status: 'pushed' });
    provider = {
      async getBranchHead() {
        return remoteHead;
      },
      async push(_t, token, input) {
        tokens.push(token);
        const result = nextResult();
        if (result instanceof Error) throw result;
        if (result.status === 'pushed') {
          pushes.push({ commit: input.commit, tags: input.tags });
          remoteHead = input.commit;
        }
        return result;
      },
    };
    pusher = new MirrorPusher({
      marketplaces: world.marketplaces,
      releases: world.releases,
      repositories: world.repositories,
      provider,
      credentials: { resolve: async (id) => `token-for-${id}` },
      clock: { now: () => new Date('2026-10-01T12:00:00Z') },
    });
  });
  afterEach(async () => {
    await world.close();
  });

  const state = async () => (await world.marketplaces.getById(world.marketplace.id))?.mirrorStatus;

  it('25.5 pushes the release commit and tag; the credential comes from the resolver', async () => {
    const result = await pusher.push(world.marketplace.id);
    expect(result).toMatchObject({ status: 'ok', lastPushedSeq: 1, attempts: 0 });
    const latest = await world.releases.latest(world.marketplace.id);
    expect(pushes).toEqual([{ commit: latest?.gitCommit, tags: ['release-1'] }]);
    expect(tokens).toEqual(['token-for-s1']);
    expect((await state())?.status).toBe('ok');
    // Nothing new: no second push.
    await pusher.push(world.marketplace.id);
    expect(pushes).toHaveLength(1);
  });

  it('25.5 pushes every missing release tag as a fast-forward after several releases', async () => {
    await pusher.push(world.marketplace.id);
    world.marketplaces.current = asResolved(sampleItems().slice(0, 2));
    await world.service.publish(world.marketplace.id);
    world.marketplaces.current = asResolved(sampleItems().slice(0, 1));
    const third = await world.service.publish(world.marketplace.id);
    await pusher.push(world.marketplace.id);
    expect(pushes.at(-1)).toEqual({
      commit: third.record.gitCommit,
      tags: ['release-2', 'release-3'],
    });
  });

  it('25.5 marks the mirror diverged and stops when the remote branch is not in the release history; never forces', async () => {
    remoteHead = 'd'.repeat(40);
    const result = await pusher.push(world.marketplace.id);
    expect(result.status).toBe('diverged');
    expect(pushes).toEqual([]);
    expect((await state())?.status).toBe('diverged');
    // Stays stopped, even when forced, until an admin resets it.
    expect((await pusher.push(world.marketplace.id, { force: true })).status).toBe('diverged');
    expect(pushes).toEqual([]);
    const reset = await pusher.reset(world.marketplace.id);
    expect(reset.status).toBe('idle');
    remoteHead = null;
    expect((await pusher.push(world.marketplace.id)).status).toBe('ok');
  });

  it('25.5 a push rejected as non-fast-forward also marks the mirror diverged', async () => {
    nextResult = () => ({ status: 'rejected-non-fast-forward' });
    expect((await pusher.push(world.marketplace.id)).status).toBe('diverged');
  });

  it('25.5 failed pushes retry with backoff and show their error on the marketplace page', async () => {
    nextResult = () => new Error('HTTP 502');
    const first = await pusher.push(world.marketplace.id);
    expect(first).toMatchObject({
      status: 'retrying',
      attempts: 1,
      lastError: 'HTTP 502',
      nextAttemptAt: '2026-10-01T12:01:00.000Z',
    });
    // Not due yet: skipped without calling the provider.
    const calls = tokens.length;
    await pusher.push(world.marketplace.id);
    expect(tokens).toHaveLength(calls);
    // A manual push ignores the backoff.
    const forced = await pusher.push(world.marketplace.id, { force: true });
    expect(forced).toMatchObject({ attempts: 2, nextAttemptAt: '2026-10-01T12:05:00.000Z' });
    nextResult = () => ({ status: 'pushed' });
    const ok = await pusher.push(world.marketplace.id, { force: true });
    expect(ok).toMatchObject({ status: 'ok', attempts: 0, lastError: null, nextAttemptAt: null });
  });

  it('25.5 requires a configured mirror and an existing marketplace', async () => {
    world.marketplaces.add({ ...world.marketplace, mirror: null });
    await expect(pusher.push(world.marketplace.id)).rejects.toThrow(/no mirror/);
    await expect(pusher.push('nope')).rejects.toThrow(/not found/);
  });

  it('25.5 does nothing before the first release', async () => {
    const fresh = await createWorld();
    try {
      fresh.marketplaces.add({ ...fresh.marketplace, mirror: target });
      const p = new MirrorPusher({
        marketplaces: fresh.marketplaces,
        releases: fresh.releases,
        repositories: fresh.repositories,
        provider,
        credentials: { resolve: async () => 't' },
      });
      expect((await p.push(fresh.marketplace.id)).status).toBe('idle');
    } finally {
      await fresh.close();
    }
  });
});

describe.skipIf(!hasGit)('25.5 git binary provider (local remote)', () => {
  let dir: string;
  let world: World;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bastion-mirror-'));
    world = await createWorld();
    world.marketplaces.add({ ...world.marketplace, mirror: target });
    await world.service.publish(world.marketplace.id);
    execFileSync('git', ['init', '--bare', '-b', 'main', join(dir, 'remote.git')], {
      stdio: 'ignore',
    });
  });
  afterEach(async () => {
    await world.close();
    await rm(dir, { recursive: true, force: true });
  });

  const mk = () =>
    new MirrorPusher({
      marketplaces: world.marketplaces,
      releases: world.releases,
      repositories: world.repositories,
      provider: createGitBinaryProvider({ urlFor: () => join(dir, 'remote.git') }),
      credentials: { resolve: async () => 'secret' },
    });
  const remoteGit = (...args: string[]) =>
    execFileSync('git', ['--git-dir', join(dir, 'remote.git'), ...args], {
      encoding: 'utf8',
    }).trim();

  it('25.5 pushes fast-forwards with tags to an empty remote and then to a later release', async () => {
    const pusher = mk();
    expect((await pusher.push(world.marketplace.id)).status).toBe('ok');
    const r1 = await world.releases.latest(world.marketplace.id);
    expect(remoteGit('rev-parse', 'main')).toBe(r1?.gitCommit);
    expect(remoteGit('tag', '--list')).toBe('release-1');
    world.marketplaces.current = asResolved(sampleItems().slice(0, 1));
    const r2 = await world.service.publish(world.marketplace.id);
    expect((await pusher.push(world.marketplace.id)).status).toBe('ok');
    expect(remoteGit('rev-parse', 'main')).toBe(r2.record.gitCommit);
    expect(remoteGit('rev-parse', 'release-2^')).toBe(r1?.gitCommit);
  });

  it('25.5 detects a diverged remote and leaves it untouched (no force push)', async () => {
    // Put a foreign commit on the remote's main.
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-b', 'main', other], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '--allow-empty', '-m', 'foreign'],
      { cwd: other, stdio: 'ignore' },
    );
    execFileSync('git', ['push', join(dir, 'remote.git'), 'main'], { cwd: other, stdio: 'ignore' });
    const foreign = remoteGit('rev-parse', 'main');
    const result = await mk().push(world.marketplace.id);
    expect(result.status).toBe('diverged');
    expect(remoteGit('rev-parse', 'main')).toBe(foreign);
  });

  it('25.5 reports a rejected non-fast-forward push and a failing remote', async () => {
    const provider = createGitBinaryProvider({ urlFor: () => join(dir, 'remote.git') });
    const repo = await world.repositories.ensure(world.marketplace, 1);
    const latest = await world.releases.latest(world.marketplace.id);
    // Race: the remote gains a foreign commit between the head check and the push.
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-b', 'main', other], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '--allow-empty', '-m', 'foreign'],
      { cwd: other, stdio: 'ignore' },
    );
    execFileSync('git', ['push', join(dir, 'remote.git'), 'main'], { cwd: other, stdio: 'ignore' });
    expect(
      await provider.push(target, 't', {
        gitdir: repo.gitdir,
        commit: latest?.gitCommit ?? '',
        tags: ['release-1'],
      }),
    ).toEqual({
      status: 'rejected-non-fast-forward',
    });
    const broken = createGitBinaryProvider({ urlFor: () => join(dir, 'missing.git') });
    await expect(broken.getBranchHead(target, 't')).rejects.toThrow(/ls-remote/);
    await expect(
      broken.push(target, 't', { gitdir: repo.gitdir, commit: latest?.gitCommit ?? '', tags: [] }),
    ).rejects.toThrow(/push failed/);
  });
});
