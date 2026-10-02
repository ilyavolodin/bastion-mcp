import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseManager } from '../src/ownership/lease';
import { WorkerRegistry } from '../src/ownership/registry';
import { gracefulShutdown, InflightTracker } from '../src/ownership/shutdown';
import { FakeRedis } from './helpers/fake-redis';

const makeWorker = (redis: FakeRedis, workerId: string, clock = { now: () => Date.now() }) => {
  const registry = new WorkerRegistry({
    redis,
    workerId,
    address: `10.0.0.${workerId.length}:7443`,
    role: 'worker',
    version: '1.0.0',
    clock,
  });
  const leases = new LeaseManager({ redis, registry, clock });
  return { registry, leases };
};

describe('21.2 worker registry', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    vi.useFakeTimers();
    redis = new FakeRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('21.2 writes workers:{id} = {address, role, version, startedAt} with a 15 s TTL', async () => {
    const { registry } = makeWorker(redis, 'w1');
    await registry.heartbeat();
    const info = await registry.lookup('w1');
    expect(info).toMatchObject({
      address: '10.0.0.2:7443',
      role: 'worker',
      version: '1.0.0',
      draining: false,
    });
    expect(typeof info?.startedAt).toBe('number');
    const ttl = (redis.hashes.get('workers:w1')?.expiresAt ?? 0) - Date.now();
    expect(ttl).toBeLessThanOrEqual(15_000);
    expect(ttl).toBeGreaterThan(14_000);
  });

  it('21.2 refreshes the entry every 5 s and it expires 15 s after the worker stops', async () => {
    const { registry } = makeWorker(redis, 'w1');
    await registry.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await registry.lookup('w1')).not.toBeNull();
    // Heartbeats stop (a crash): the entry lapses.
    clearInterval((registry as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await registry.lookup('w1')).toBeNull();
  });

  it('21.2 marks the worker draining and deletes the entry on stop', async () => {
    const { registry } = makeWorker(redis, 'w1');
    await registry.start();
    await registry.markDraining();
    expect((await registry.lookup('w1'))?.draining).toBe(true);
    expect(registry.isDraining).toBe(true);
    await registry.stop();
    expect(await registry.lookup('w1')).toBeNull();
  });

  it('21.3 a Redis outage during a heartbeat is logged, not thrown', async () => {
    const { registry } = makeWorker(redis, 'w1');
    redis.failing = true;
    await expect(registry.heartbeat()).resolves.toBeUndefined();
  });

  it('21.2 a malformed registry entry reads as absent', async () => {
    await redis.hset('workers:weird', { nonsense: '1' });
    const { registry } = makeWorker(redis, 'w1');
    expect(await registry.lookup('weird')).toBeNull();
  });
});

describe('21.2 owner leases', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    vi.useFakeTimers();
    redis = new FakeRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('21.2 an empty lease is taken with SET NX PX 15000 and then attaches', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    const attached: string[] = [];
    const result = await a.leases.acquire('inst', {
      attach: async () => void attached.push('inst'),
      onLost: () => undefined,
    });
    expect(result).toEqual({ kind: 'local', fresh: true });
    expect(attached).toEqual(['inst']);
    expect(await redis.get('lease:inst')).toBe('w1');
    const ttl = (redis.strings.get('lease:inst')?.expiresAt ?? 0) - Date.now();
    expect(ttl).toBeLessThanOrEqual(15_000);
    expect(a.leases.isOwner('inst')).toBe(true);
  });

  it('21.2 a lease that names this worker uses the local connection without attaching again', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    let attaches = 0;
    const options = {
      attach: async () => {
        attaches += 1;
      },
      onLost: () => undefined,
    };
    await a.leases.acquire('inst', options);
    const again = await a.leases.acquire('inst', options);
    expect(again).toEqual({ kind: 'local', fresh: false });
    expect(attaches).toBe(1);
  });

  it('21.2 a lease held by another registered worker means forward to its address', async () => {
    const a = makeWorker(redis, 'w1');
    const b = makeWorker(redis, 'w22');
    await a.registry.heartbeat();
    await b.registry.heartbeat();
    await a.leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined });
    const result = await b.leases.acquire('inst', {
      attach: async () => {
        throw new Error('must not attach');
      },
      onLost: () => undefined,
    });
    expect(result).toEqual({ kind: 'forward', workerId: 'w1', address: '10.0.0.2:7443' });
  });

  it('21.2 a dead owner is taken over: compare-and-delete of the stale value, then NX, then attach', async () => {
    const a = makeWorker(redis, 'w1');
    const b = makeWorker(redis, 'w22');
    await a.registry.heartbeat();
    await b.registry.heartbeat();
    await a.leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined });
    // w1 crashes: its registry entry lapses while the lease value is still there.
    await redis.del('workers:w1');
    const order: string[] = [];
    const result = await b.leases.acquire('inst', {
      attach: async () => void order.push('attach'),
      onLost: () => undefined,
    });
    expect(result).toEqual({ kind: 'local', fresh: true });
    expect(await redis.get('lease:inst')).toBe('w22');
    expect(order).toEqual(['attach']);
  });

  it('21.2 a failing attach gives the lease back and rethrows', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    await expect(
      a.leases.acquire('inst', {
        attach: async () => {
          throw new Error('attach failed');
        },
        onLost: () => undefined,
      }),
    ).rejects.toThrow('attach failed');
    expect(await redis.get('lease:inst')).toBeNull();
    expect(a.leases.isOwner('inst')).toBe(false);
  });

  it('21.2 a draining worker takes no new ownership', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.markDraining();
    await expect(
      a.leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined }),
    ).rejects.toThrow(/draining/);
  });

  it('21.2 renews every 5 s with compare-and-PEXPIRE so the lease outlives its 15 s TTL', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    await a.leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await redis.get('lease:inst')).toBe('w1');
    expect(a.leases.isOwner('inst')).toBe(true);
  });

  it('21.2 a lease that can no longer be renewed is treated as lost and the connection is closed', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    const lost: string[] = [];
    await a.leases.acquire('inst', {
      attach: async () => undefined,
      onLost: () => void lost.push('inst'),
    });
    await redis.set('lease:inst', 'someone-else');
    await a.leases.renewAll();
    expect(lost).toEqual(['inst']);
    expect(a.leases.isOwner('inst')).toBe(false);
    // The thief's lease is untouched.
    expect(await redis.get('lease:inst')).toBe('someone-else');
  });

  it('21.2 renewal failures from a Redis outage lose the lease only after its TTL has passed', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    const lost: string[] = [];
    await a.leases.acquire('inst', {
      attach: async () => undefined,
      onLost: () => void lost.push('x'),
    });
    redis.failing = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toEqual(['x']);
  });

  it('21.2 release deletes only a lease this worker still holds', async () => {
    const a = makeWorker(redis, 'w1');
    await a.registry.heartbeat();
    await a.leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined });
    await redis.set('lease:inst', 'other');
    await a.leases.release('inst');
    expect(await redis.get('lease:inst')).toBe('other');
  });

  it('21.2 locate reports local, forward and vacant without taking the lease', async () => {
    const a = makeWorker(redis, 'w1');
    const b = makeWorker(redis, 'w22');
    await a.registry.heartbeat();
    await b.registry.heartbeat();
    expect(await a.leases.locate('inst')).toEqual({ kind: 'vacant' });
    await a.leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined });
    expect(await a.leases.locate('inst')).toEqual({ kind: 'local', fresh: false });
    expect(await b.leases.locate('inst')).toMatchObject({ kind: 'forward', workerId: 'w1' });
    await redis.del('workers:w1');
    expect(await b.leases.locate('inst')).toEqual({ kind: 'vacant' });
  });

  it('21.2 two workers racing for one empty lease: exactly one becomes the owner', async () => {
    const a = makeWorker(redis, 'w1');
    const b = makeWorker(redis, 'w22');
    await a.registry.heartbeat();
    await b.registry.heartbeat();
    let attaches = 0;
    const attach = async () => {
      attaches += 1;
    };
    const [ra, rb] = await Promise.all([
      a.leases.acquire('inst', { attach, onLost: () => undefined }),
      b.leases.acquire('inst', { attach, onLost: () => undefined }),
    ]);
    expect([ra.kind, rb.kind].sort()).toEqual(['forward', 'local']);
    expect(attaches).toBe(1);
  });
});

describe('21.2 graceful shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('21.2 marks draining, waits for in-flight work, closes connections, deletes leases, keeps sandboxes', async () => {
    const redis = new FakeRedis();
    const { registry, leases } = makeWorker(redis, 'w1');
    await registry.heartbeat();
    await leases.acquire('inst', { attach: async () => undefined, onLost: () => undefined });
    const inflight = new InflightTracker();
    let release!: () => void;
    const op = inflight.track(() => new Promise<void>((resolve) => (release = resolve)));
    const closed: string[] = [];
    const shutdown = gracefulShutdown({
      registry,
      leases,
      inflight,
      closeConnections: async () => void closed.push('closed'),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(registry.isDraining).toBe(true);
    expect(closed).toEqual([]);
    expect(await redis.get('lease:inst')).toBe('w1');
    release();
    await op;
    const result = await shutdown;
    expect(result.drained).toBe(true);
    expect(closed).toEqual(['closed']);
    expect(await redis.get('lease:inst')).toBeNull();
    expect(await registry.lookup('w1')).toBeNull();
  });

  it('21.2 gives up on in-flight operations after 25 s', async () => {
    const redis = new FakeRedis();
    const { registry, leases } = makeWorker(redis, 'w1');
    const inflight = new InflightTracker();
    void inflight.track(() => new Promise<void>(() => undefined));
    const shutdown = gracefulShutdown({
      registry,
      leases,
      inflight,
      closeConnections: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(25_001);
    expect((await shutdown).drained).toBe(false);
  });

  it('21.2 InflightTracker.drain resolves immediately when idle', async () => {
    const t = new InflightTracker();
    expect(t.active).toBe(0);
    await expect(t.drain(10)).resolves.toBe(true);
  });
});
