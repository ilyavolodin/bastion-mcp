import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyCallScope } from '../src/input-required/call-scope';
import { ContinuationRegistry, lookupContinuation } from '../src/input-required/registry';
import { FakeRedis } from './helpers/fake-redis';

const FULL = { elicitation: { form: {}, url: {} } };

describe('6.5 continuation registry (cont:{continuationId})', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    vi.useFakeTimers();
    redis = new FakeRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const scopeWithRequest = async (id: string) => {
    const scope = new LegacyCallScope({ id, clientCapabilities: FULL, roots: [] });
    scope.attach(new Promise(() => undefined));
    void scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    return scope;
  };

  it('6.5 records {instanceId, workerId, pendingKeys, createdAt} with a 10 minute TTL', async () => {
    const registry = new ContinuationRegistry({ redis, workerId: 'w1', instanceId: 'i1' });
    const scope = await scopeWithRequest('c-1');
    await registry.publish(scope);
    const record = await lookupContinuation(redis, 'c-1');
    expect(record).toMatchObject({ instanceId: 'i1', workerId: 'w1', pendingKeys: ['b0'] });
    expect(redis.hashes.get('cont:c-1')?.expiresAt).toBeDefined();
    const ttl = (redis.hashes.get('cont:c-1')?.expiresAt ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    expect(registry.get('c-1')).toBe(scope);
  });

  it('6.5 without a retry the TTL expires the continuation and answers pending requests', async () => {
    const registry = new ContinuationRegistry({
      redis,
      workerId: 'w1',
      instanceId: 'i1',
      ttlMs: 1000,
    });
    const scope = new LegacyCallScope({ id: 'c-2', clientCapabilities: FULL, roots: [] });
    scope.attach(new Promise(() => undefined));
    const pending = scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    await registry.publish(scope);
    await vi.advanceTimersByTimeAsync(1001);
    await expect(pending).resolves.toEqual({ action: 'cancel' });
    expect(registry.get('c-2')).toBeUndefined();
    expect(await lookupContinuation(redis, 'c-2')).toBeNull();
  });

  it('6.5 hold() stops the TTL while a retry is being served and publish re-arms it', async () => {
    const registry = new ContinuationRegistry({
      redis,
      workerId: 'w1',
      instanceId: 'i1',
      ttlMs: 1000,
    });
    const scope = await scopeWithRequest('c-3');
    await registry.publish(scope);
    registry.hold('c-3');
    await vi.advanceTimersByTimeAsync(5000);
    expect(registry.get('c-3')).toBe(scope);
    await registry.publish(scope);
    await vi.advanceTimersByTimeAsync(1001);
    expect(registry.get('c-3')).toBeUndefined();
  });

  it('6.5 the record disappears when the upstream call settles', async () => {
    const registry = new ContinuationRegistry({ redis, workerId: 'w1', instanceId: 'i1' });
    let finish!: (v: unknown) => void;
    const scope = new LegacyCallScope({ id: 'c-4', clientCapabilities: FULL, roots: [] });
    scope.attach(new Promise((resolve) => (finish = resolve)));
    void scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    await registry.publish(scope);
    finish('done');
    await vi.advanceTimersByTimeAsync(5);
    expect(await lookupContinuation(redis, 'c-4')).toBeNull();
    expect(registry.size).toBe(0);
  });

  it('6.5 closeAll disposes every continuation (the owner connection closed)', async () => {
    const registry = new ContinuationRegistry({ redis, workerId: 'w1', instanceId: 'i1' });
    const scope = await scopeWithRequest('c-5');
    await registry.publish(scope);
    await registry.closeAll();
    expect(registry.size).toBe(0);
    expect(scope.abort.signal.aborted).toBe(true);
  });

  it('6.5 a malformed or missing record reads as lost', async () => {
    expect(await lookupContinuation(redis, 'nope')).toBeNull();
    await redis.hset('cont:bad', {
      instanceId: 'i',
      workerId: 'w',
      pendingKeys: 'not json',
      createdAt: '1',
    });
    expect(await lookupContinuation(redis, 'bad')).toBeNull();
  });
});
