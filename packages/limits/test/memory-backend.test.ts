import { describe, expect, it } from 'vitest';
import { EngineLimiter, MemoryBackend, type OperationContext, parseRule } from '../src';

const op: OperationContext = { principal: { orgId: 'o', userId: 'u1' }, method: 'tools/call' };
const base = { name: 'R', subject: 'user' };

describe('14.2 / 21.3 in-memory fallback usage', () => {
  it('21.3 reports usage scaled to 1/expectedWorkers without consuming', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(2), { timeZone: 'UTC' });
    const rate = parseRule({
      ...base,
      id: 'rate',
      kind: 'rate',
      params: { points: 10, perSeconds: 60, burst: 4 },
    });
    const quota = parseRule({
      ...base,
      id: 'quota',
      kind: 'quota',
      params: { points: 10, period: 'day' },
    });
    const conc = parseRule({
      ...base,
      id: 'conc',
      kind: 'concurrency',
      params: { max: 4, leaseSeconds: 60 },
    });
    await limiter.check(op, [rate, quota, conc], 'r1');

    expect(await limiter.readUsage(rate, 'u1')).toMatchObject({
      limit: 5,
      consumed: 1,
      remaining: 4,
    });
    expect(await limiter.readUsage(quota, 'u1')).toMatchObject({
      limit: 5,
      consumed: 1,
      remaining: 4,
    });
    expect(await limiter.readUsage(conc, 'u1')).toMatchObject({
      limit: 2,
      consumed: 1,
      remaining: 1,
    });
    expect(await limiter.readUsage(rate, 'u1')).toMatchObject({ consumed: 1 });
    expect(await limiter.readUsage(rate, 'nobody')).toMatchObject({ consumed: 0, resetsAt: null });
  });

  it('21.3 a rate rule without burst uses the sustained limiter only', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1));
    const rate = parseRule({
      ...base,
      id: 'r',
      kind: 'rate',
      params: { points: 1, perSeconds: 60, burst: 0 },
    });
    await limiter.check(op, [rate], 'a');
    await expect(limiter.check(op, [rate], 'b')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
