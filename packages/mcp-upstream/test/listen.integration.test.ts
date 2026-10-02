import { redisKeys } from '@bastion-mcp/core';
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
import type { UriMapper } from '../src/listen/events';
import type { RedisLike, ResolvedCredential, ResolvedInstallation } from '../src/ports';
import { installationOf, principal, remoteSpec, sleep } from './helpers/fixtures';
import { newShared } from './helpers/harness';
import { newWorld, startWorker, type TestWorker, type TestWorld } from './helpers/runtime';

const credential: ResolvedCredential = { injections: [], credentialHash: 'cred-1' };

const prefixMapper: UriMapper = {
  toDownstream: (_i, uri) => [`bastion+${uri}`],
  toUpstream: (_i, uri) => uri.replace(/^bastion\+/, ''),
};

describe.skipIf(!dockerAvailable())(
  '6.6 upstream notifications and subscriptions against real Redis',
  () => {
    let redisServer: TestRedis;
    let redis: Redis;
    let modern: FakeModernServer;
    let legacy: FakeLegacyHttpServer;
    const workers: TestWorker[] = [];
    const subscribers: Redis[] = [];

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
      for (const s of subscribers.splice(0)) s.disconnect();
      for (const w of workers.splice(0)) {
        await w.runtime.stop(300).catch(() => undefined);
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
      const started = await startWorker(w, id, {
        listen: { graceMs: 400, tickMs: 100 },
        uris: prefixMapper,
        ...overrides,
      });
      workers.push(started);
      return started;
    };
    const events = async (): Promise<unknown[]> => {
      const sub = new Redis(redisServer.url);
      subscribers.push(sub);
      const received: unknown[] = [];
      await sub.subscribe('bastion:notify');
      sub.on('message', (_c, m) => received.push(JSON.parse(m)));
      return received;
    };
    const modernInstallation = (): ResolvedInstallation =>
      installationOf(remoteSpec(modern.url), { installationId: 'inst-m', slug: 'modern' });
    const legacyInstallation = (): ResolvedInstallation =>
      installationOf(remoteSpec(legacy.url), { installationId: 'inst-l', slug: 'legacy' });
    const listens = () =>
      modern.requests.filter(
        (r) => (r.body as { method?: string } | undefined)?.method === 'subscriptions/listen',
      ).length;

    it('6.6 the ulisten lease holder opens ONE listen per installation and credential for any number of subscribers', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const before = listens();
      await a.runtime.listen.join({ installation: inst, principal, credential });
      await b.runtime.listen.join({ installation: inst, principal, credential });
      await a.runtime.listen.join({ installation: inst, principal, credential });
      await sleep(500);
      expect(await redis.get(redisKeys.listenRefs('inst-m', 'cred-1'))).toBe('3');
      expect(await redis.get(redisKeys.listenLease('inst-m', 'cred-1'))).toBe('w1');
      expect(listens() - before).toBe(1);
      expect(a.runtime.listen.openListens()).toBe(1);
      expect(b.runtime.listen.openListens()).toBe(0);
      expect(a.runtime.listen.isHolding({ installation: inst, principal, credential })).toBe(true);
    });

    it('6.6 the listen closes 60 s (here 400 ms) after the last subscriber leaves, and not before', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const args = { installation: inst, principal, credential };
      await a.runtime.listen.join(args);
      await a.runtime.listen.join(args);
      await sleep(300);
      expect(await a.runtime.listen.leave(args)).toBe(1);
      await sleep(700);
      expect(a.runtime.listen.openListens()).toBe(1);
      expect(await a.runtime.listen.leave(args)).toBe(0);
      await sleep(250);
      expect(a.runtime.listen.openListens()).toBe(1); // grace not over yet
      await sleep(900);
      expect(a.runtime.listen.openListens()).toBe(0);
      expect(await redis.get(redisKeys.listenLease('inst-m', 'cred-1'))).toBeNull();
      // The count never goes below zero.
      expect(await a.runtime.listen.leave(args)).toBe(0);
    });

    it('6.6 a subscriber that returns within the grace period keeps the stream open', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const args = { installation: inst, principal, credential };
      await a.runtime.listen.join(args);
      await sleep(300);
      const before = listens();
      await a.runtime.listen.leave(args);
      await sleep(200);
      await a.runtime.listen.join(args);
      await sleep(1000);
      expect(a.runtime.listen.openListens()).toBe(1);
      expect(listens()).toBe(before);
    });

    it('6.6 21.2 when the holder dies another worker with subscribers takes the ulisten lease', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const args = { installation: inst, principal, credential };
      await a.runtime.listen.join(args);
      await b.runtime.listen.join(args);
      await sleep(300);
      expect(await redis.get(redisKeys.listenLease('inst-m', 'cred-1'))).toBe('w1');
      await a.crash();
      await sleep(800);
      expect(await redis.get(redisKeys.listenLease('inst-m', 'cred-1'))).toBe('w22');
      expect(b.runtime.listen.openListens()).toBe(1);
    });

    it('6.6 modern remote: a resource subscription goes to the lease holder, updates map back to the downstream URI', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const received = await events();
      const args = { installation: inst, principal, credential };
      await a.runtime.listen.join(args);
      await sleep(300);
      // The subscriber is on worker b, the holder is a: the subscription is forwarded over internal RPC.
      await b.runtime.listen.subscribeResource({
        ...args,
        downstreamUri: 'bastion+test://static',
        endpointId: 'ep-1',
      });
      await sleep(500);
      modern.resourceUpdated('test://static');
      modern.resourceUpdated('test://not-subscribed');
      await sleep(700);
      const updates = received.filter((e) => (e as { kind: string }).kind === 'resource_updated');
      expect(updates).toEqual([
        {
          targets: { principalIds: ['user-1'] },
          kind: 'resource_updated',
          uri: 'bastion+test://static',
        },
      ]);
    });

    it('6.6 modern remote: list_changed arrives on the listen stream, invalidates the cache and is published', async () => {
      const w = world();
      const inst = w.installations.add(modernInstallation());
      const a = await worker(w, 'w1');
      const received = await events();
      await a.runtime.lists.cache.put('inst-m', 'cred-1', 'tools/list', {
        items: [{ name: 'stale' }],
        ttlMs: 60_000,
      });
      await a.runtime.listen.join({ installation: inst, principal, credential });
      await sleep(400);
      modern.toolsChanged();
      await sleep(700);
      expect(await redis.exists('lc:inst-m:cred-1:tools/list')).toBe(0);
      expect(received).toContainEqual({
        targets: { principalIds: ['user-1'] },
        kind: 'tools_list_changed',
      });
    });

    it('6.6 legacy remote: the owner registers the upstream subscription once and unregisters after the last subscriber', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation());
      const a = await worker(w, 'w1');
      const b = await worker(w, 'w22');
      const received = await events();
      const args = { installation: inst, principal, credential };
      await a.runtime.listen.subscribeResource({ ...args, downstreamUri: 'bastion+test://static' });
      // A second subscriber on another worker is forwarded to the owner and shares the upstream subscription.
      await b.runtime.listen.subscribeResource({ ...args, downstreamUri: 'bastion+test://static' });
      expect(legacy.subscriptions()).toEqual(['test://static']);
      await sleep(200);
      legacy.resourceUpdated('test://static');
      await sleep(500);
      expect(received).toContainEqual({
        targets: { principalIds: ['user-1'] },
        kind: 'resource_updated',
        uri: 'bastion+test://static',
      });
      await b.runtime.listen.unsubscribeResource({
        ...args,
        downstreamUri: 'bastion+test://static',
      });
      expect(legacy.subscriptions()).toEqual(['test://static']);
      await a.runtime.listen.unsubscribeResource({
        ...args,
        downstreamUri: 'bastion+test://static',
      });
      expect(legacy.subscriptions()).toEqual([]);
    });

    it('6.6 legacy remote: list_changed on the owner stream invalidates both cache layers and is published', async () => {
      const w = world();
      const inst = w.installations.add(legacyInstallation());
      const a = await worker(w, 'w1');
      const received = await events();
      // Open the owned session, then seed the cache.
      await a.runtime.listen.subscribeResource({
        installation: inst,
        principal,
        credential,
        downstreamUri: 'bastion+test://static',
      });
      await a.runtime.lists.cache.put('inst-l', 'cred-1', 'tools/list', {
        items: [{ name: 'stale' }],
        ttlMs: 60_000,
      });
      await sleep(300);
      legacy.toolsChanged();
      await sleep(600);
      expect(await redis.exists('lc:inst-l:cred-1:tools/list')).toBe(0);
      expect(received).toContainEqual({
        targets: { principalIds: ['user-1'] },
        kind: 'tools_list_changed',
      });
    });

    it('6.6 installation notify targets override the connection principal', async () => {
      const w = world();
      const inst = w.installations.add({
        ...legacyInstallation(),
        notifyTargets: { teamIds: ['eng'] },
      });
      const a = await worker(w, 'w1');
      const received = await events();
      await a.runtime.listen.subscribeResource({
        installation: inst,
        principal,
        credential,
        downstreamUri: 'bastion+test://static',
      });
      await sleep(300);
      legacy.toolsChanged();
      await sleep(500);
      expect(received).toContainEqual({
        targets: { teamIds: ['eng'] },
        kind: 'tools_list_changed',
      });
    });
  },
);
