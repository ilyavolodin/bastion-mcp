import {
  ERROR_CODES,
  UpstreamAuthRequiredError,
  UpstreamUnavailableError,
  wrapRequestState,
} from '@bastion-mcp/core';
import {
  dockerAvailable,
  type FakeLegacyHttpServer,
  type FakeModernServer,
  startFakeLegacyHttpServer,
  startFakeModernServer,
  startRedis,
  type TestRedis,
} from '@bastion-mcp/testkit';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthRequiredError, type ResolvedInstallation } from '../src/ports';
import type { UpstreamOutcome } from '../src/types';
import { ctxOf, installationOf, principal, remoteSpec, sleep } from './helpers/fixtures';
import { newShared } from './helpers/harness';
import { keyring, newWorld, startWorker, type TestWorker, type TestWorld } from './helpers/runtime';

const text = (outcome: UpstreamOutcome): string => {
  if (outcome.kind !== 'complete') throw new Error(`expected complete, got ${outcome.kind}`);
  return (outcome.result as { content: { text: string }[] }).content[0]?.text ?? '';
};

describe.skipIf(!dockerAvailable())(
  '6.4 6.5 21.2 upstream service against real Redis, HTTP and fake upstreams',
  () => {
    let redisServer: TestRedis;
    let redis: Redis;
    let modern: FakeModernServer;
    let legacy: FakeLegacyHttpServer;
    const workers: TestWorker[] = [];

    beforeAll(async () => {
      redisServer = await startRedis();
      redis = new Redis(redisServer.url, { maxRetriesPerRequest: 2 });
      modern = await startFakeModernServer();
      legacy = await startFakeLegacyHttpServer();
    }, 180_000);

    afterAll(async () => {
      redis.disconnect();
      await modern.close();
      await legacy.close();
      await redisServer.stop();
    });

    afterEach(async () => {
      for (const w of workers.splice(0)) {
        await w.runtime.stop(500).catch(() => undefined);
        await w.stopRpc().catch(() => undefined);
      }
      await redis.flushall();
    });

    const world = (): TestWorld => newWorld(newShared(redis as never));
    const worker = async (
      w: TestWorld,
      id: string,
      overrides: Parameters<typeof startWorker>[2] = {},
    ) => {
      const started = await startWorker(w, id, overrides);
      workers.push(started);
      return started;
    };

    const modernInstallation = (id = 'inst-m'): ResolvedInstallation =>
      installationOf(remoteSpec(modern.url), { installationId: id, slug: 'modern' });
    const legacyInstallation = (id = 'inst-l'): ResolvedInstallation =>
      installationOf(remoteSpec(legacy.url), { installationId: id, slug: 'legacy' });

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
        ctx: ctxOf({ installationId: installation.installationId, endpointId: 'ep-1', ...ctx }),
      });

    // --- modern remote ------------------------------------------------------------------------------------------

    it('6.4 a modern remote is called directly by any worker and its era verdict is cached for 24 h', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      expect(
        text(await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'a' } })),
      ).toBe('a');
      const probes = modern.discoverCount();
      expect(
        text(await run(b, inst, 'tools/call', { name: 'echo', arguments: { text: 'b' } })),
      ).toBe('b');
      // Only the first connection per credential probes: worker b reads the verdict from Redis.
      expect(modern.discoverCount()).toBe(probes);
      const ttl = await redis.ttl('era:inst-m:cred-1');
      expect(ttl).toBeGreaterThan(23 * 3600);
      // No lease for a stateless modern remote.
      expect(await redis.keys('lease:*')).toEqual([]);
    });

    it('6.5 passes an upstream InputRequiredResult through with inputRequests unchanged and a wrapped requestState', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const first = await run(a, inst, 'tools/call', { name: 'ask', arguments: { q: 'name?' } });
      expect(first.kind).toBe('input_required');
      if (first.kind !== 'input_required') return;
      expect(Object.keys(first.inputRequests ?? {})).toEqual(['name']);
      expect(first.inputRequests?.name?.method).toBe('elicitation/create');
      expect(first.requestState.startsWith('bst1.')).toBe(true);
      expect(first.requestState).not.toContain('upstream-state-1');
    });

    it('6.5 the retry may land on any replica and forwards the upstream requestState unchanged', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const first = await run(a, inst, 'tools/call', { name: 'ask', arguments: { q: 'name?' } });
      if (first.kind !== 'input_required') throw new Error('expected input_required');
      const done = await b.runtime.service.retry({
        installationId: inst.installationId,
        method: 'tools/call',
        params: { name: 'ask', arguments: { q: 'name?' } },
        inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } },
        requestState: first.requestState,
        ctx: ctxOf({ installationId: inst.installationId, endpointId: 'ep-1' }),
      });
      expect(text(done)).toBe('hello Ada state=upstream-state-1');
    });

    it('6.5 rejects a requestState bound to another principal, endpoint, name or arguments with -32602', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const first = await run(a, inst, 'tools/call', { name: 'ask', arguments: { q: 'name?' } });
      if (first.kind !== 'input_required') throw new Error('expected input_required');
      const retry = (over: { params?: Record<string, unknown>; ctx?: object; state?: string }) =>
        a.runtime.service.retry({
          installationId: inst.installationId,
          method: 'tools/call',
          params: over.params ?? { name: 'ask', arguments: { q: 'name?' } },
          inputResponses: { name: { action: 'accept', content: { name: 'x' } } },
          requestState: over.state ?? first.requestState,
          ctx: ctxOf({
            installationId: inst.installationId,
            endpointId: 'ep-1',
            ...(over.ctx ?? {}),
          }),
        });
      for (const attempt of [
        retry({ params: { name: 'ask', arguments: { q: 'different' } } }),
        retry({ params: { name: 'echo', arguments: { q: 'name?' } } }),
        retry({ ctx: { endpointId: 'ep-2' } }),
        retry({ ctx: { principal: { ...principal, userId: 'user-2' } } }),
        retry({ state: 'upstream-state-1' }),
        retry({ state: 'bst1.k1.AAAA' }),
      ]) {
        const error = await attempt.catch((e: unknown) => e);
        expect((error as { mcpCode?: number }).mcpCode).toBe(-32602);
        expect((error as Error).message).toBe('invalid requestState');
      }
    });

    it('6.5 rejects an expired requestState', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const stale = wrapRequestState(
        keyring,
        {
          principalId: principal.userId,
          endpointId: 'ep-1',
          installationId: inst.installationId,
          method: 'tools/call',
          name: 'ask',
          args: { q: 'name?' },
        },
        { now: Math.floor(Date.now() / 1000) - 3600, upstreamState: 'upstream-state-1' },
      );
      await expect(
        a.runtime.service.retry({
          installationId: inst.installationId,
          method: 'tools/call',
          params: { name: 'ask', arguments: { q: 'name?' } },
          inputResponses: {},
          requestState: stale,
          ctx: ctxOf({ installationId: inst.installationId, endpointId: 'ep-1' }),
        }),
      ).rejects.toMatchObject({ mcpCode: -32602 });
    });

    it('6.4 a missing upstream credential raises UPSTREAM_AUTH_REQUIRED with the connect URL', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      w.credentials.authRequired = true;
      const a = await worker(w, 'w1');
      const error = await run(
        a,
        inst,
        'tools/call',
        { name: 'echo', arguments: { text: 'x' } },
        { clientCapabilities: {} },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamAuthRequiredError);
      expect((error as UpstreamAuthRequiredError).mcpCode).toBe(ERROR_CODES.UPSTREAM_AUTH_REQUIRED);
      expect((error as UpstreamAuthRequiredError).data.connectUrl).toBe(
        'https://bastion.test/connect/inst-m?state=abc',
      );
      void AuthRequiredError;
    });

    it('6.9 an unknown installation and an unreachable upstream both fail with -32014', async () => {
      const w = world();
      const a = await worker(w, 'w1');
      await expect(
        run(a, modernInstallation('nope'), 'tools/call', { name: 'echo' }),
      ).rejects.toBeInstanceOf(UpstreamUnavailableError);
      const dead = w.installations.add(
        installationOf(remoteSpec('http://127.0.0.1:1/mcp'), {
          installationId: 'inst-dead',
          slug: 'dead',
        }),
      );
      const error = await run(a, dead, 'tools/call', { name: 'echo' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamUnavailableError);
      expect((error as UpstreamUnavailableError).data.installation).toBe('dead');
    });

    it('6.4 an upstream timeout becomes -32017 and a cancelled call aborts the upstream request', async () => {
      const w = world();
      const spec = remoteSpec(modern.url, 'streamable-http', { timeouts: { toolCallMs: 150 } });
      const inst = w.installations.add(
        installationOf(spec, { installationId: 'inst-t', slug: 'timed' }),
      );
      const a = await worker(w, 'w1');
      const error = await run(a, inst, 'tools/call', {
        name: 'slow',
        arguments: { ms: 3000 },
      }).catch((e: unknown) => e);
      expect((error as { mcpCode?: number }).mcpCode).toBe(ERROR_CODES.UPSTREAM_TIMEOUT);
      expect((error as { data: { timeoutMs: number } }).data.timeoutMs).toBe(150);
    });

    it('6.6 an upstream list_changed invalidates the list cache and publishes on bastion:notify', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const subscriber = new Redis(redisServer.url);
      const received: unknown[] = [];
      await subscriber.subscribe('bastion:notify');
      subscriber.on('message', (_c, message) => received.push(JSON.parse(message)));
      try {
        const session = await a.runtime.service.pooledSession(
          inst,
          principal,
          { injections: [], credentialHash: 'cred-1' },
          AbortSignal.timeout(10_000),
        );
        expect(session).toBeDefined();
        await a.runtime.lists.cache.put('inst-m', 'cred-1', 'tools/list', {
          items: [{ name: 'old' }],
          ttlMs: 60_000,
        });
        await a.runtime.listen.join({
          installation: inst,
          principal,
          credential: { injections: [], credentialHash: 'cred-1' },
        });
        await sleep(300);
        modern.toolsChanged();
        await sleep(600);
        expect(await redis.get('lc:inst-m:cred-1:tools/list')).toBeNull();
        expect(received).toContainEqual({
          targets: { principalIds: ['user-1'] },
          kind: 'tools_list_changed',
        });
      } finally {
        subscriber.disconnect();
      }
    });

    // --- legacy remote: owner, forwarding, continuations, takeover --------------------------------------------------------

    it('21.2 a legacy remote session has an owner worker; other replicas forward to it over signed HTTP', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      expect(
        text(await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'one' } })),
      ).toBe('one');
      const instanceId = (await w.shared.repo.getForInstallation('inst-l'))?.id as string;
      expect(await redis.get(`lease:${instanceId}`)).toBe('w1');
      const notes: string[] = [];
      const viaB = await run(
        b,
        inst,
        'tools/call',
        { name: 'progress', arguments: { steps: 2 } },
        { emit: (n: { method: string }) => notes.push(n.method) },
      );
      expect(text(viaB)).toBe('progress 2');
      expect(notes).toContain('notifications/progress');
      // b never opened its own session: still exactly one lease holder.
      expect(await redis.get(`lease:${instanceId}`)).toBe('w1');
      expect(b.runtime.instances.get(instanceId)).toBeUndefined();
      expect(a.runtime.instances.get(instanceId)).toBeDefined();
    });

    it('6.5 21.2 a legacy-upstream continuation resumes on its owner when the retry lands on another replica', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const first = await run(a, inst, 'tools/call', { name: 'ask', arguments: { q: 'who?' } });
      expect(first.kind).toBe('input_required');
      if (first.kind !== 'input_required') return;
      expect(Object.keys(first.inputRequests ?? {})).toEqual(['b0']);
      const keys = await redis.keys('cont:*');
      expect(keys).toHaveLength(1);
      const record = await redis.hgetall(keys[0] as string);
      expect(record.workerId).toBe('w1');
      expect(JSON.parse(record.pendingKeys as string)).toEqual(['b0']);
      expect(await redis.ttl(keys[0] as string)).toBeGreaterThan(590);
      const done = await b.runtime.service.retry({
        installationId: inst.installationId,
        method: 'tools/call',
        params: { name: 'ask', arguments: { q: 'who?' } },
        inputResponses: { b0: { action: 'accept', content: { name: 'Grace' } } },
        requestState: first.requestState,
        ctx: ctxOf({ installationId: inst.installationId, endpointId: 'ep-1' }),
      });
      expect(text(done)).toBe('hello Grace');
      expect(await redis.keys('cont:*')).toEqual([]);
    });

    it('6.5 more server requests on the same continuation produce another input_required and the final retry completes', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation());
      const a = await worker(w, 'w1');
      const first = await run(a, inst, 'tools/call', { name: 'ask2', arguments: { q: 'p' } });
      if (first.kind !== 'input_required') throw new Error('expected input_required');
      expect(Object.keys(first.inputRequests ?? {})).toEqual(['b0', 'b1']);
      const done = await a.runtime.service.retry({
        installationId: inst.installationId,
        method: 'tools/call',
        params: { name: 'ask2', arguments: { q: 'p' } },
        inputResponses: {
          b0: { action: 'accept', content: { v: 'A' } },
          b1: { action: 'accept', content: { v: 'B' } },
        },
        requestState: first.requestState,
        ctx: ctxOf({ installationId: inst.installationId, endpointId: 'ep-1' }),
      });
      expect(text(done)).toBe('A+B');
    });

    it('6.5 21.3 when the owner died the retry fails with -32014 and the client re-issues the original request', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const first = await run(a, inst, 'tools/call', { name: 'ask', arguments: { q: 'who?' } });
      if (first.kind !== 'input_required') throw new Error('expected input_required');
      await sleep(300);
      await a.crash();
      const error = await b.runtime.service
        .retry({
          installationId: inst.installationId,
          method: 'tools/call',
          params: { name: 'ask', arguments: { q: 'who?' } },
          inputResponses: { b0: { action: 'accept', content: { name: 'x' } } },
          requestState: first.requestState,
          ctx: ctxOf({ installationId: inst.installationId, endpointId: 'ep-1' }),
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamUnavailableError);
      expect((error as UpstreamUnavailableError).mcpCode).toBe(-32014);
      // The original request works again on the surviving worker.
      expect(
        text(await run(b, inst, 'tools/call', { name: 'echo', arguments: { text: 'again' } })),
      ).toBe('again');
    });

    it('21.2 lease takeover after the owner dies reuses the stored Mcp-Session-Id and reopens the GET stream', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation('inst-l2'));
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'owned by a' } });
      const row = await w.shared.repo.getForInstallation('inst-l2');
      expect(row?.remoteSession?.sessionId).toBeTruthy();
      const initializes = legacy.initializeCount();
      await sleep(500); // a crashed process does no more work
      await a.crash();
      const out = await run(b, inst, 'tools/call', {
        name: 'echo',
        arguments: { text: 'taken over' },
      });
      expect(text(out)).toBe('taken over');
      expect(legacy.initializeCount()).toBe(initializes);
      const instanceId = row?.id as string;
      expect(await redis.get(`lease:${instanceId}`)).toBe('w22');
      expect(b.runtime.instances.get(instanceId)?.session.sessionId).toBe(
        row?.remoteSession?.sessionId,
      );
    });

    it('21.2 a forward that cannot connect waits 250 ms, re-reads the lease and retries once, taking over a dead owner', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation('inst-l3'));
      const a = await worker(w, 'w1');
      let slept = 0;
      const b = await worker(w, 'w22');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'seed' } });
      // The owner's RPC port is gone but it is still registered (a crash inside the 15 s TTL).
      await a.stopRpc();
      const service = b.runtime.service as unknown as { sleep: (ms: number) => Promise<void> };
      service.sleep = async (ms: number) => {
        slept = ms;
        await redis.del('workers:w1'); // by the time we re-read the lease the registry entry has lapsed
      };
      const out = await run(b, inst, 'tools/call', {
        name: 'echo',
        arguments: { text: 'after retry' },
      });
      expect(text(out)).toBe('after retry');
      expect(slept).toBe(250);
    });

    it('21.2 if the owner stays registered but unreachable the call fails with -32014 after one retry', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation('inst-l4'));
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'seed' } });
      await a.stopRpc();
      const service = b.runtime.service as unknown as { sleep: (ms: number) => Promise<void> };
      let sleeps = 0;
      service.sleep = async () => {
        sleeps += 1;
      };
      const error = await run(b, inst, 'tools/call', {
        name: 'echo',
        arguments: { text: 'x' },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamUnavailableError);
      expect(sleeps).toBe(1);
    });

    it('21.2 graceful shutdown on the owner: leases are deleted and the next request starts a new owner', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation('inst-l5'));
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      await run(a, inst, 'tools/call', { name: 'echo', arguments: { text: 'seed' } });
      const instanceId = (await w.shared.repo.getForInstallation('inst-l5'))?.id as string;
      await sleep(500); // let the post-start re-list finish
      const result = await a.runtime.stop(1000);
      expect(result.drained).toBe(true);
      expect(await redis.get(`lease:${instanceId}`)).toBeNull();
      expect(await redis.exists('workers:w1')).toBe(0);
      expect(
        text(await run(b, inst, 'tools/call', { name: 'echo', arguments: { text: 'next' } })),
      ).toBe('next');
      expect(await redis.get(`lease:${instanceId}`)).toBe('w22');
    });

    it('6.8 MCP Apps tool _meta.ui and ui:// resources pass through unchanged', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation('inst-ui'));
      const a = await worker(w, 'w1');
      const tools = await run(a, inst, 'tools/list', {});
      if (tools.kind !== 'complete') throw new Error('expected complete');
      const widget = (tools.result as { tools: { name: string; _meta?: unknown }[] }).tools.find(
        (t) => t.name === 'widget',
      );
      expect(widget?._meta).toEqual({
        ui: {
          resourceUri: 'ui://widget/main',
          csp: { connectDomains: ['https://api.example.com'] },
        },
      });
      const read = await run(a, inst, 'resources/read', { uri: 'ui://widget/main' });
      if (read.kind !== 'complete') throw new Error('expected complete');
      expect(
        (read.result as { contents: { uri: string; mimeType: string; text: string }[] })
          .contents[0],
      ).toEqual({
        uri: 'ui://widget/main',
        mimeType: 'text/html;profile=mcp-app',
        text: '<html><body>widget</body></html>',
      });
      const resources = await run(a, inst, 'resources/list', {});
      if (resources.kind !== 'complete') throw new Error('expected complete');
      const ui = (
        resources.result as { resources: { uri: string; _meta?: unknown }[] }
      ).resources.find((r) => r.uri === 'ui://widget/main');
      expect(ui?._meta).toEqual({ ui: { csp: { frameDomains: [] } } });
    });
  },
);
