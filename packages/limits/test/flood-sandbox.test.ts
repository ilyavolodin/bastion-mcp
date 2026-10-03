import { RateLimitedError } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { FloodLimiter, floodBucketFor, planSandboxStart, type SandboxInstanceInfo } from '../src';

describe('14.2 floodBucketFor', () => {
  it.each([
    ['/mcp', 'mcp'],
    ['/mcp/', 'mcp'],
    ['/mcp/acme/github', 'mcp'],
    ['/mcp?x=1', 'mcp'],
    ['/oauth/token', 'oauth'],
    ['/oauth/register', 'oauth'],
    ['/oauth/token?grant=x', 'oauth'],
  ])('14.2 maps %s to the %s bucket', (path, bucket) => {
    expect(floodBucketFor(path)).toBe(bucket);
  });

  it.each(['/', '/api/v1/me', '/mcpx', '/oauth/authorize', '/oauth/token/extra', '/health'])(
    '14.2 leaves %s unlimited',
    (path) => {
      expect(floodBucketFor(path)).toBeUndefined();
    },
  );
});

describe('14.2 FloodLimiter', () => {
  it('14.2 admits up to the per-minute limit then reports a retry delay in whole seconds', async () => {
    const flood = new FloodLimiter({ mcpPerMinute: 2, oauthPerMinute: 1 });
    expect(await flood.check('1.1.1.1', 'mcp')).toEqual({ ok: true, retryAfterSec: 0 });
    expect(await flood.check('1.1.1.1', 'mcp')).toEqual({ ok: true, retryAfterSec: 0 });
    const blocked = await flood.check('1.1.1.1', 'mcp');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    expect(Number.isInteger(blocked.retryAfterSec)).toBe(true);
  });

  it('14.2 counts each IP on its own', async () => {
    const flood = new FloodLimiter({ mcpPerMinute: 1, oauthPerMinute: 1 });
    expect((await flood.check('1.1.1.1', 'mcp')).ok).toBe(true);
    expect((await flood.check('1.1.1.1', 'mcp')).ok).toBe(false);
    expect((await flood.check('2.2.2.2', 'mcp')).ok).toBe(true);
  });

  it('14.2 keeps the mcp and oauth buckets apart', async () => {
    const flood = new FloodLimiter({ mcpPerMinute: 1, oauthPerMinute: 1 });
    expect((await flood.check('1.1.1.1', 'mcp')).ok).toBe(true);
    expect((await flood.check('1.1.1.1', 'oauth')).ok).toBe(true);
    expect((await flood.check('1.1.1.1', 'oauth')).ok).toBe(false);
  });

  it('14.2 uses the documented defaults when none are given', async () => {
    const flood = new FloodLimiter();
    for (let i = 0; i < 60; i++) expect((await flood.check('9.9.9.9', 'oauth')).ok).toBe(true);
    expect((await flood.check('9.9.9.9', 'oauth')).ok).toBe(false);
    expect((await flood.check('9.9.9.9', 'mcp')).ok).toBe(true);
  });
});

describe('8.6 planSandboxStart', () => {
  const inst = (id: string, over: Partial<SandboxInstanceInfo> = {}): SandboxInstanceInfo => ({
    id,
    state: 'running',
    idleEligible: true,
    lastUsedAt: 1000,
    ...over,
  });

  it('8.6 starts when there is room, counting only running and starting instances', () => {
    expect(planSandboxStart([], 1)).toEqual({ action: 'start' });
    expect(
      planSandboxStart([inst('a', { state: 'stopped' }), inst('b', { state: 'failed' })], 1),
    ).toEqual({ action: 'start' });
  });

  it('8.6 stops the least recently used idle instance at the cap', () => {
    const plan = planSandboxStart(
      [
        inst('new', { lastUsedAt: 5000 }),
        inst('old', { lastUsedAt: 1000 }),
        inst('mid', { lastUsedAt: 3000 }),
      ],
      3,
    );
    expect(plan).toEqual({ action: 'stop-then-start', stopInstanceId: 'old' });
  });

  it('8.6 accepts Date and numeric timestamps in the same list', () => {
    const plan = planSandboxStart(
      [inst('a', { lastUsedAt: new Date(2000) }), inst('b', { lastUsedAt: 1000 })],
      2,
    );
    expect(plan).toEqual({ action: 'stop-then-start', stopInstanceId: 'b' });
  });

  it('8.6 never stops a busy or still-starting instance', () => {
    const plan = planSandboxStart(
      [
        inst('busy', { idleEligible: false, lastUsedAt: 1 }),
        inst('boot', { state: 'starting', lastUsedAt: 2 }),
      ],
      2,
    );
    expect(plan.action).toBe('reject');
  });

  it('8.6 rejects with RATE_LIMITED naming the cap and a retry hint', () => {
    const plan = planSandboxStart([inst('a', { idleEligible: false })], 1);
    if (plan.action !== 'reject') throw new Error('expected reject');
    expect(plan.error).toBeInstanceOf(RateLimitedError);
    expect(plan.error.message).toContain('1 running sandboxes');
    expect(plan.error.data).toMatchObject({
      retryAfterMs: 5000,
      limit: 'running sandboxes per user',
    });
  });

  it('8.6 does not mutate the instance list it is given', () => {
    const list = [inst('b', { lastUsedAt: 2 }), inst('a', { lastUsedAt: 1 })];
    planSandboxStart(list, 2);
    expect(list.map((i) => i.id)).toEqual(['b', 'a']);
  });
});
