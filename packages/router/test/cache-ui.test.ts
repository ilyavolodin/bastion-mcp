import { describe, expect, it } from 'vitest';
import { collisionWarnings, type EffectiveEndpoint, EndpointCache, toolCountWarning } from '../src';

const endpoint = (over: Partial<EffectiveEndpoint> = {}): EffectiveEndpoint =>
  ({
    endpointId: 'e1',
    principalId: 'p1',
    configVersion: '1',
    tools: [],
    installations: [],
    collisions: [],
    dependencies: { installationIds: ['i1'], catalogEntryIds: ['c1'], teamIds: ['t1'] },
    ...over,
  }) as unknown as EffectiveEndpoint;

const key = (configVersion = '1', principalId = 'p1', endpointId = 'e1') => ({
  principalId,
  endpointId,
  configVersion,
});

describe('4.3 EndpointCache', () => {
  it('4.3 caches per (principal, endpoint, configVersion) and compiles once', async () => {
    const cache = new EndpointCache();
    let n = 0;
    const compile = async () => endpoint({ configVersion: String(++n) });
    const a = await cache.getOrCompile(key(), compile);
    const b = await cache.getOrCompile(key(), compile);
    expect(a).toBe(b);
    expect(n).toBe(1);
    await cache.getOrCompile(key('2'), compile);
    await cache.getOrCompile(key('1', 'other'), compile);
    expect(n).toBe(3);
    expect(cache.size).toBe(3);
  });

  it('4.3 single flight: concurrent callers share one compilation', async () => {
    const cache = new EndpointCache();
    let n = 0;
    const compile = async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return endpoint();
    };
    const [a, b, c] = await Promise.all([
      cache.getOrCompile(key(), compile),
      cache.getOrCompile(key(), compile),
      cache.getOrCompile(key(), compile),
    ]);
    expect(n).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('4.3 a failed compilation is not cached and the next call retries', async () => {
    const cache = new EndpointCache();
    await expect(
      cache.getOrCompile(key(), async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    expect((await cache.getOrCompile(key(), async () => endpoint())).endpointId).toBe('e1');
  });

  it('4.3 entries expire after the 60 s TTL', async () => {
    let now = 0;
    const cache = new EndpointCache({ now: () => now });
    let n = 0;
    const compile = async () => {
      n++;
      return endpoint();
    };
    await cache.getOrCompile(key(), compile);
    now = 59_999;
    await cache.getOrCompile(key(), compile);
    expect(n).toBe(1);
    now = 60_001;
    expect(cache.get(key())).toBeUndefined();
    await cache.getOrCompile(key(), compile);
    expect(n).toBe(2);
  });

  it('4.3 evicts the least recently used entry', async () => {
    const cache = new EndpointCache({ maxEntries: 2 });
    for (const v of ['1', '2'])
      await cache.getOrCompile(key(v), async () => endpoint({ configVersion: v }));
    cache.get(key('1'));
    await cache.getOrCompile(key('3'), async () => endpoint({ configVersion: '3' }));
    expect(cache.get(key('2'))).toBeUndefined();
    expect(cache.get(key('1'))).toBeDefined();
    expect(cache.get(key('3'))).toBeDefined();
  });

  it('4.3 bastion:config events drop matching entries by scope', async () => {
    const cache = new EndpointCache();
    const fill = async () => {
      cache.clear();
      await cache.getOrCompile(key(), async () => endpoint());
      await cache.getOrCompile(key('1', 'p2', 'e2'), async () =>
        endpoint({
          principalId: 'p2',
          endpointId: 'e2',
          dependencies: { installationIds: ['i2'], catalogEntryIds: ['c2'], teamIds: [] },
        }),
      );
    };
    await fill();
    expect(cache.invalidate({ scope: 'user', id: 'p1' })).toBe(1);
    await fill();
    expect(cache.invalidate({ scope: 'endpoint', id: 'e2' })).toBe(1);
    await fill();
    expect(cache.invalidate({ scope: 'installation', id: 'i1' })).toBe(1);
    await fill();
    expect(cache.invalidate({ scope: 'catalog', id: 'c2' })).toBe(1);
    await fill();
    expect(cache.invalidate({ scope: 'team', id: 't1' })).toBe(1);
    await fill();
    expect(cache.invalidate({ scope: 'org', id: 'org' })).toBe(2);
    await fill();
    expect(cache.invalidate({ scope: 'weird', id: 'x' })).toBe(2);
    await fill();
    expect(cache.invalidate({ scope: 'user', id: 'nobody' })).toBe(0);
  });

  it('4.3 an event with a version leaves entries compiled from a newer configVersion', async () => {
    const cache = new EndpointCache();
    await cache.getOrCompile(key('5'), async () => endpoint({ configVersion: '5' }));
    expect(cache.invalidate({ scope: 'user', id: 'p1', version: 4 })).toBe(0);
    expect(cache.invalidate({ scope: 'user', id: 'p1', version: 5 })).toBe(1);
  });

  it('4.3 an invalidation during compilation prevents caching the stale result', async () => {
    const cache = new EndpointCache();
    let n = 0;
    await cache.getOrCompile(key(), async () => {
      cache.invalidate({ scope: 'org', id: 'x' });
      n += 1;
      return endpoint();
    });
    expect(cache.get(key())).toBeUndefined();
    await cache.getOrCompile(key(), async () => {
      n++;
      return endpoint();
    });
    expect(n).toBe(2);
  });

  it('15.3 reports compile duration in seconds through onCompile', async () => {
    const seen: number[] = [];
    const cache = new EndpointCache({ onCompile: (s) => seen.push(s) });
    await cache.getOrCompile(key(), async () => endpoint());
    await cache.getOrCompile(key(), async () => endpoint());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(0);
  });
});

describe('7.1 UI support', () => {
  const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}` }));
  const installations = [
    { id: 'a', displayName: 'A', toolCount: 10 },
    { id: 'b', displayName: 'B', toolCount: 35 },
    { id: 'c', displayName: 'C', toolCount: 0 },
  ];

  it('7.1 warns when the tool count passes endpoints.toolWarnThreshold (default 40)', () => {
    const over = toolCountWarning({ tools: tools(41), installations } as never);
    expect(over).toMatchObject({
      count: 41,
      threshold: 40,
      exceeded: true,
      actions: ['split_endpoint', 'hide_tools'],
    });
    expect(over.byInstallation.map((i) => i.installationId)).toEqual(['b', 'a']);
    expect(toolCountWarning({ tools: tools(40), installations } as never).exceeded).toBe(false);
    expect(toolCountWarning({ tools: tools(10), installations } as never, 5)).toMatchObject({
      exceeded: true,
      threshold: 5,
    });
  });

  it('7.3 collision warnings are shown on every installation involved', () => {
    const w = collisionWarnings({
      collisions: [
        { kind: 'tool', name: 'search', installationIds: ['a', 'b'] },
        { kind: 'prompt', name: 'p', installationIds: ['b'] },
      ],
    });
    expect(w.get('a')).toHaveLength(1);
    expect(w.get('b')).toHaveLength(2);
    expect(w.has('c')).toBe(false);
  });
});
