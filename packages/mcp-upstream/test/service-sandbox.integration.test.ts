import { RateLimitedError, UpstreamUnavailableError } from '@bastion-mcp/core';
import type { InstallationInfo } from '@bastion-mcp/router';
import { dockerAvailable, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PinChecker, RedisLike, ResolvedInstallation } from '../src/ports';
import type { UpstreamOutcome } from '../src/types';
import { ctxOf, installationOf, packageSpec, sleep } from './helpers/fixtures';
import { newShared } from './helpers/harness';
import { newWorld, startWorker, type TestWorker, type TestWorld } from './helpers/runtime';

const text = (outcome: UpstreamOutcome): string => {
  if (outcome.kind !== 'complete') throw new Error(`expected complete, got ${outcome.kind}`);
  return (outcome.result as { content: { text: string }[] }).content[0]?.text ?? '';
};

const infoOf = (installation: ResolvedInstallation): InstallationInfo =>
  ({ id: installation.installationId, slug: installation.slug }) as unknown as InstallationInfo;

describe.skipIf(!dockerAvailable())(
  '8.6 21.2 7.5 sandbox upstreams and snapshot-served lists against real Redis',
  () => {
    let redisServer: TestRedis;
    let redis: Redis;
    const workers: TestWorker[] = [];

    beforeAll(async () => {
      redisServer = await startRedis();
      redis = new Redis(redisServer.url, { maxRetriesPerRequest: 2 });
    }, 180_000);
    afterAll(async () => {
      redis.disconnect();
      await redisServer.stop();
    });
    afterEach(async () => {
      for (const w of workers.splice(0)) {
        await w.runtime.stop(500).catch(() => undefined);
        await w.stopRpc().catch(() => undefined);
      }
      await redis.flushall();
    });

    const world = (): TestWorld => newWorld(newShared(redis as unknown as RedisLike));
    const worker = async (
      w: TestWorld,
      id: string,
      overrides: Parameters<typeof startWorker>[2] = {},
    ) => {
      const started = await startWorker(w, id, overrides);
      workers.push(started);
      return started;
    };
    const sandboxInstallation = (id = 'inst-s'): ResolvedInstallation =>
      installationOf(packageSpec({ egress: { allow: ['api.example.com'] } }), {
        installationId: id,
        slug: 'sandboxed',
      });
    const run = (
      w: TestWorker,
      installation: ResolvedInstallation,
      method: string,
      params: Record<string, unknown>,
      ctx = {},
    ) =>
      w.runtime.service.execute({
        installationId: installation.installationId,
        method,
        params,
        ctx: ctxOf({
          installationId: installation.installationId,
          endpointId: 'ep-1',
          era: 'legacy',
          ...ctx,
        }),
      });

    it('8.6 a sandbox starts on the first operation, owned by one worker and reached by others through forwarding', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      expect(
        text(await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'one' } })),
      ).toBe('one');
      expect(
        text(await run(b, inst, 'tools/call', { name: 'echo', arguments: { text: 'two' } })),
      ).toBe('two');
      expect(w.shared.driver.createCount).toBe(1);
      const row = await w.shared.repo.getForInstallation('inst-s');
      expect(await redis.get(`lease:${row?.id}`)).toBe('w1');
      expect(await redis.hget(`egress:${row?.id}`, 'phase')).toBe('running');
      expect(JSON.parse((await redis.hget(`egress:${row?.id}`, 'allow')) as string)).toEqual([
        'api.example.com',
      ]);
    });

    it('6.5 a stdio (legacy) upstream continuation resumes across two workers', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const first = await run(
        a,
        inst,
        'tools/call',
        { name: 'ask', arguments: { q: 'who?' } },
        { era: 'modern' },
      );
      expect(first.kind).toBe('input_required');
      if (first.kind !== 'input_required') return;
      const done = await b.runtime.service.retry({
        installationId: inst.installationId,
        method: 'tools/call',
        params: { name: 'ask', arguments: { q: 'who?' } },
        inputResponses: { b0: { action: 'accept', content: { name: 'Linus' } } },
        requestState: first.requestState,
        ctx: ctxOf({ installationId: inst.installationId, endpointId: 'ep-1' }),
      });
      expect(text(done)).toBe('hello Linus');
    });

    it('8.6 a crash fails the in-flight request with -32014 and the next call restarts the sandbox (after the backoff)', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'warm' } });
      const error = await run(a, inst, 'tools/call', { name: 'crash', arguments: {} }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UpstreamUnavailableError);
      expect((error as UpstreamUnavailableError).mcpCode).toBe(-32014);
      await sleep(100);
      // A crash within 30 s of start counts as a failure: calls fail fast with -32016 until the 5 s backoff passes.
      const failFast = await run(a, inst, 'tools/call', {
        name: 'echo',
        arguments: { text: 'x' },
      }).catch((e: unknown) => e);
      expect((failFast as { mcpCode?: number }).mcpCode).toBe(-32016);
      expect(w.shared.driver.createCount).toBe(1);
    });

    it('21.2 after a graceful shutdown another worker attaches to the still-running sandbox', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'seed' } });
      await sleep(500); // let the post-start re-list finish before the worker shuts down
      await a.runtime.stop(500);
      expect(w.shared.driver.sandboxes.get('bst-1')?.state).toBe('running');
      expect(
        text(await run(b, inst, 'tools/call', { name: 'echo', arguments: { text: 'after' } })),
      ).toBe('after');
      expect(w.shared.driver.attachCount).toBe(1);
      expect(w.shared.driver.createCount).toBe(1);
    });

    it('21.2 after the owner crashes (lease left behind) another worker takes over and attaches', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'seed' } });
      await sleep(500); // let the post-start re-list finish: a crashed process does no more work
      await a.crash();
      expect(
        text(await run(b, inst, 'tools/call', { name: 'echo', arguments: { text: 'takeover' } })),
      ).toBe('takeover');
      expect(w.shared.driver.attachCount).toBe(1);
      expect(w.shared.driver.createCount).toBe(1);
    });

    it('8.6 the per-user running cap surfaces as -32011 through the service', async () => {
      const w = world();
      const a = await worker(w, 'w1', { limits: { maxRunningPerUser: 1, maxRunningTotal: 500 } });
      const one = w.installations.add(sandboxInstallation('inst-1'));
      const two = w.installations.add(sandboxInstallation('inst-2'));
      const busy = run(a, one, 'tools/call', { name: 'slow', arguments: { ms: 600 } });
      await sleep(500);
      const error = await run(a, two, 'tools/call', {
        name: 'echo',
        arguments: { text: 'x' },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitedError);
      await busy;
    });

    // --- lists ---------------------------------------------------------------------------------------------------------

    it('7.5 serves a list from the latest snapshot without starting a sandbox', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      await w.snapshots.put('inst-s', inst.configHash, {
        tools: [{ name: 'from-snapshot' }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
      });
      const a = await worker(w, 'w1');
      const result = await a.runtime.lists.listItems(infoOf(inst), {
        principalId: 'user-1',
        endpointId: 'ep-1',
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.origin).toBe('snapshot');
      expect(result.items.tools).toEqual([{ name: 'from-snapshot' }]);
      expect(w.shared.driver.createCount).toBe(0);
    });

    it('7.5 a catalog reference snapshot with the same configHash seeds a new installation', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      w.snapshots.references.set(`${inst.catalogVersionId}:${inst.configHash}`, {
        tools: [{ name: 'reference' }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
      });
      const a = await worker(w, 'w1');
      const result = await a.runtime.lists.listItems(infoOf(inst), {
        principalId: 'user-1',
        endpointId: 'ep-1',
      });
      expect(result).toMatchObject({ status: 'ok', origin: 'reference' });
      expect(w.shared.driver.createCount).toBe(0);
    });

    it('7.5 with no snapshot the list starts the instance, reads all lists, writes the snapshot and caches them', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      const first = await a.runtime.lists.listItems(infoOf(inst), {
        principalId: 'user-1',
        endpointId: 'ep-1',
      });
      expect(first.status).toBe('ok');
      if (first.status !== 'ok') return;
      expect(first.origin).toBe('started');
      expect((first.items.tools as { name: string }[]).map((t) => t.name)).toContain('echo');
      expect(w.shared.driver.createCount).toBe(1);
      expect(w.snapshots.snapshots.has(`inst-s:${inst.configHash}`)).toBe(true);
      // 6.7 both cache layers hold the lists for (installationId, credentialHash)
      expect(await redis.exists('lc:inst-s:cred-1:tools/list')).toBe(1);
      expect(await redis.exists('lc:inst-s:cred-1:resources/templates/list')).toBe(1);
      const second = await a.runtime.lists.listItems(infoOf(inst), {
        principalId: 'user-1',
        endpointId: 'ep-1',
      });
      expect(second).toMatchObject({ status: 'ok', origin: 'cache' });
      expect(a.runtime.lists.cache.size).toBeGreaterThan(0);
    });

    it('6.7 invalidation deletes the per-worker LRU entries and the Redis keys', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      await a.runtime.lists.listItems(infoOf(inst), { principalId: 'user-1', endpointId: 'ep-1' });
      expect(await redis.keys('lc:inst-s:cred-1:*')).toHaveLength(4);
      await a.runtime.lists.invalidate('inst-s', 'cred-1');
      expect(await redis.keys('lc:inst-s:cred-1:*')).toHaveLength(0);
      expect(await a.runtime.lists.cache.get('inst-s', 'cred-1', 'tools/list')).toBeNull();
      // Without a credential hash every hash this worker cached is dropped.
      await a.runtime.lists.cache.put('inst-s', 'other', 'tools/list', { items: [] });
      await a.runtime.lists.invalidate('inst-s');
      expect(await redis.keys('lc:inst-s:*')).toHaveLength(0);
    });

    it('7.5 with no snapshot and a slow start the installation is degraded after the wait and list_changed follows', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      w.shared.driver.startDelayMs = 500;
      const a = await worker(w, 'w1');
      (
        a.runtime.lists as unknown as { deps: { startWaitMs: number; changed: unknown } }
      ).deps.startWaitMs = 80;
      (a.runtime.lists as unknown as { deps: { changed: unknown } }).deps.changed =
        w.changed.publisher;
      const result = await a.runtime.lists.listItems(infoOf(inst), {
        principalId: 'user-1',
        endpointId: 'ep-1',
      });
      expect(result).toEqual({ status: 'degraded', code: 'starting' });
      await sleep(1500);
      expect(w.changed.calls).toContainEqual({
        installationId: 'inst-s',
        kinds: ['tools', 'prompts', 'resources'],
      });
    });

    it('7.5 when the instance starts later, Bastion re-lists, updates the snapshot and emits list_changed if anything differs', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      await w.snapshots.put('inst-s', inst.configHash, {
        tools: [{ name: 'stale-tool' }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
      });
      const a = await worker(w, 'w1', { changed: w.changed.publisher });
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'start' } });
      await sleep(800);
      const snapshot = await w.snapshots.get('inst-s', inst.configHash);
      expect(((snapshot?.tools ?? []) as { name: string }[]).map((t) => t.name)).toContain('echo');
      expect(
        w.changed.calls.some((c) => c.installationId === 'inst-s' && c.kinds.includes('tools')),
      ).toBe(true);
    });

    it('7.5 an auth-required installation is reported degraded instead of failing the whole list', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      w.credentials.authRequired = true;
      const a = await worker(w, 'w1');
      expect(
        await a.runtime.lists.listItems(infoOf(inst), {
          principalId: 'user-1',
          endpointId: 'ep-1',
        }),
      ).toEqual({
        status: 'degraded',
        code: 'auth_required',
      });
      expect(
        await a.runtime.lists.listItems({ id: 'ghost' } as InstallationInfo, {
          principalId: 'u',
          endpointId: 'e',
        }),
      ).toEqual({
        status: 'degraded',
        code: 'installation_missing',
      });
    });

    it('13.6 a definition pin drift hides changed tools, blocks the installation or only warns, per the policy', async () => {
      const mk = async (verdict: Awaited<ReturnType<PinChecker['check']>>) => {
        const w = world();
        const inst = w.installations.add(sandboxInstallation());
        const a = await worker(w, `w${Math.random().toString(36).slice(2, 6)}`, {
          pins: { check: async () => verdict },
        });
        return a.runtime.lists.listItems(infoOf(inst), {
          principalId: 'user-1',
          endpointId: 'ep-1',
        });
      };
      const hide = await mk({ ok: false, changed: ['echo'], action: 'hideChanged' });
      if (hide.status !== 'ok') throw new Error('expected ok');
      const names = (hide.items.tools as { name: string }[]).map((t) => t.name);
      expect(names).not.toContain('echo');
      expect(names).toContain('whoami');
      const block = await mk({ ok: false, changed: ['echo'], action: 'block' });
      expect(block).toEqual({ status: 'degraded', code: 'pin_drift_blocked' });
      const warn = await mk({ ok: false, changed: ['echo'], action: 'warn' });
      if (warn.status !== 'ok') throw new Error('expected ok');
      expect((warn.items.tools as { name: string }[]).map((t) => t.name)).toContain('echo');
    });

    it('6.2 the router UpstreamCaller adapter runs an operation through the same routing', async () => {
      const w = world();
      const inst = w.installations.add(sandboxInstallation());
      const a = await worker(w, 'w1');
      const out = await a.runtime.lists.call(
        infoOf(inst),
        { method: 'tools/call', name: 'echo', arguments: { text: 'via router' } },
        { principalId: 'user-1', endpointId: 'ep-1' },
      );
      expect((out.result as { content: { text: string }[] }).content[0]?.text).toBe('via router');
      const asking = await a.runtime.lists.call(
        infoOf(inst),
        { method: 'tools/call', name: 'ask', arguments: { q: 'x' } },
        { principalId: 'user-1', endpointId: 'ep-1' },
      );
      // No client capabilities are known to this adapter, so the elicitation is declined upstream (6.5).
      expect((asking.result as { content: { text: string }[] }).content[0]?.text).toBe(
        'action:decline',
      );
    });
  },
);
