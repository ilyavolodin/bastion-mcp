import { redisKeys } from '@bastion-mcp/core';
import { type FakeLegacyHttpServer, startFakeLegacyHttpServer } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import {
  connectClient,
  seedInstallation,
  startTestWorker,
  type TestWorker,
  textOf,
} from './helpers/worker-harness';

describe.skipIf(!haveDocker())('21 two workers: ownership and forwarding', () => {
  let env: TestEnv;
  let w1: TestWorker;
  let w2: TestWorker;
  let upstream: FakeLegacyHttpServer;
  let seeded: Awaited<ReturnType<typeof seedInstallation>>;

  beforeAll(async () => {
    env = await createTestEnv();
    upstream = await startFakeLegacyHttpServer();
    w1 = await startTestWorker(env, { workerId: 'worker-one' });
    w2 = await startTestWorker(env, { workerId: 'worker-two' });
    seeded = await seedInstallation(w1.infra, {
      email: 'owner@example.com',
      slug: 'legacy',
      spec: {
        type: 'remote',
        transport: 'streamable-http',
        url: upstream.url,
        auth: { mode: 'none' },
      },
    });
  });

  afterAll(async () => {
    await w1?.stop();
    await w2?.stop();
    await upstream?.close();
    await env?.cleanup();
  });

  it('6.5 / 21.2 a legacy remote instance is owned by one worker; the other forwards over the internal RPC', async () => {
    const c1 = await connectClient(w1.base, seeded.userId);
    const first = await c1.callTool({ name: 'legacy__echo', arguments: { text: 'one' } });
    expect(textOf(first)).toContain('one');

    const afterFirst = upstream.initializeCount();
    const instance = await w1.infra.repos.instances.getForInstallation(seeded.installationId);
    expect(instance).not.toBeNull();
    const lease = await w1.infra.redis.get(redisKeys.lease(instance?.id ?? ''));
    expect(lease).toContain('worker-one');

    const c2 = await connectClient(w2.base, seeded.userId);
    const second = await c2.callTool({ name: 'legacy__echo', arguments: { text: 'two' } });
    expect(textOf(second)).toContain('two');

    // One upstream session served both workers: the second worker did not open its own.
    expect(upstream.initializeCount()).toBe(afterFirst);
    const lease2 = await w1.infra.redis.get(redisKeys.lease(instance?.id ?? ''));
    expect(lease2).toContain('worker-one');
    await c1.close();
    await c2.close();
  });

  it('21.1 both workers are registered with their internal address', async () => {
    const one = await w1.infra.redis.hgetall(redisKeys.worker('worker-one'));
    const two = await w1.infra.redis.hgetall(redisKeys.worker('worker-two'));
    expect(one.address).toBe(`127.0.0.1:${w1.internalPort}`);
    expect(two.address).toBe(`127.0.0.1:${w2.internalPort}`);
  });

  it('21.2 stopping the owner releases its lease and the other worker takes the instance over', async () => {
    await w1.worker.stop(500);
    const registered = await w2.infra.redis.hgetall(redisKeys.worker('worker-one'));
    expect(Object.keys(registered)).toHaveLength(0);
    const c2 = await connectClient(w2.base, seeded.userId);
    const result = await c2.callTool({ name: 'legacy__echo', arguments: { text: 'after' } });
    expect(textOf(result)).toContain('after');
    await c2.close();
  });
});
