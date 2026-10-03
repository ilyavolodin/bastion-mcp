import { describe, expect, it } from 'vitest';
import {
  collisionWarnings,
  DEFAULT_TOOL_WARN_THRESHOLD,
  type EffectiveEndpoint,
  type EndpointProvider,
  loadProvider,
  type ProviderContext,
  toolCountWarning,
  type UpstreamCaller,
  type UpstreamItemSource,
  type UpstreamListResult,
  UpstreamProvider,
} from '../src';
import { installation, items, tool } from './helpers';

const ctx = (): ProviderContext => ({ principalId: 'p1', endpointId: 'e1' });
const inst = installation({ id: 'i1', slug: 'github' });

const sourceOf = (
  result: () => Promise<UpstreamListResult>,
): UpstreamItemSource & { calls: number } => {
  const source = {
    calls: 0,
    async listItems() {
      source.calls += 1;
      return result();
    },
  };
  return source;
};

describe('7.2 UpstreamProvider.listAll', () => {
  it('7.2 loads once per request context even when four lists are read at once', async () => {
    const source = sourceOf(async () => ({
      status: 'ok',
      items: items({ tools: [tool('a')] }),
      origin: 'live',
    }));
    const provider = new UpstreamProvider(inst, source);
    const c = ctx();
    const [tools, prompts, resources, templates] = await Promise.all([
      provider.listTools(c),
      provider.listPrompts(c),
      provider.listResources(c),
      provider.listResourceTemplates(c),
    ]);
    expect(source.calls).toBe(1);
    expect(tools.map((t) => t.name)).toEqual(['a']);
    expect([prompts, resources, templates]).toEqual([[], [], []]);
  });

  it('7.2 shares the in-flight load between concurrent callers with the same context', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = sourceOf(async () => {
      await gate;
      return { status: 'ok', items: items(), origin: 'cache' };
    });
    const provider = new UpstreamProvider(inst, source);
    const c = ctx();
    const first = provider.listAll(c);
    const second = provider.listAll(c);
    expect(second).toBe(first);
    release();
    expect(await first).toEqual({ status: 'ok', items: items() });
    expect(source.calls).toBe(1);
  });

  it('7.2 a new request context loads again, so one request never sees a stale list', async () => {
    const source = sourceOf(async () => ({ status: 'ok', items: items(), origin: 'live' }));
    const provider = new UpstreamProvider(inst, source);
    await provider.listAll(ctx());
    await provider.listAll(ctx());
    expect(source.calls).toBe(2);
  });

  it('7.5 reports a degraded source with its code and detail', async () => {
    const provider = new UpstreamProvider(
      inst,
      sourceOf(async () => ({ status: 'degraded', code: 'needs_auth', detail: 'token expired' })),
    );
    expect(await provider.listAll(ctx())).toEqual({
      status: 'degraded',
      code: 'needs_auth',
      detail: 'token expired',
    });
  });

  it('7.5 omits the detail key when the source gave none', async () => {
    const provider = new UpstreamProvider(
      inst,
      sourceOf(async () => ({ status: 'degraded', code: 'timeout' })),
    );
    expect(await provider.listAll(ctx())).toStrictEqual({ status: 'degraded', code: 'timeout' });
  });

  it('7.5 turns a throwing source into list_failed instead of rejecting', async () => {
    const provider = new UpstreamProvider(
      inst,
      sourceOf(async () => Promise.reject(new Error('boom'))),
    );
    expect(await provider.listAll(ctx())).toEqual({ status: 'degraded', code: 'list_failed' });
  });

  it('7.5 the four list methods throw when the installation is degraded', async () => {
    const provider = new UpstreamProvider(
      inst,
      sourceOf(async () => ({ status: 'degraded', code: 'timeout' })),
    );
    await expect(provider.listTools(ctx())).rejects.toThrow('list degraded: timeout');
  });
});

describe('7.2 UpstreamProvider.call', () => {
  it('7.2 refuses to call without a caller', async () => {
    const provider = new UpstreamProvider(
      inst,
      sourceOf(async () => ({ status: 'ok', items: items(), origin: 'live' })),
    );
    await expect(provider.call({ method: 'tools/call', name: 'a' }, ctx())).rejects.toThrow(
      'no UpstreamCaller',
    );
  });

  it('7.2 forwards the installation, operation and context to the caller', async () => {
    const seen: unknown[] = [];
    const caller: UpstreamCaller = {
      async call(installationInfo, op, c) {
        seen.push(installationInfo.id, op, c.endpointId);
        return { result: 42 };
      },
    };
    const provider = new UpstreamProvider(
      inst,
      sourceOf(async () => ({ status: 'ok', items: items(), origin: 'live' })),
      caller,
    );
    const out = await provider.call({ method: 'tools/call', name: 'a' }, ctx());
    expect(out).toEqual({ result: 42 });
    expect(seen).toEqual(['i1', { method: 'tools/call', name: 'a' }, 'e1']);
  });
});

describe('26 loadProvider', () => {
  const native = (over: Partial<EndpointProvider> = {}): EndpointProvider => ({
    kind: 'native',
    installation: inst,
    listTools: async () => [tool('n')],
    listPrompts: async () => [],
    listResources: async () => [],
    listResourceTemplates: async () => [],
    call: async () => ({ result: null }),
    ...over,
  });

  it('26 prefers listAll when the provider has one', async () => {
    const listing = { status: 'ok' as const, items: items({ tools: [tool('all')] }) };
    const out = await loadProvider(native({ listAll: async () => listing }), ctx());
    expect(out).toBe(listing);
  });

  it('26 otherwise assembles the four lists', async () => {
    const out = await loadProvider(native(), ctx());
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.items.tools.map((t) => t.name)).toEqual(['n']);
  });

  it('26 maps any failing list to a degraded listing', async () => {
    const out = await loadProvider(
      native({ listPrompts: async () => Promise.reject(new Error('x')) }),
      ctx(),
    );
    expect(out).toEqual({ status: 'degraded', code: 'list_failed' });
  });
});

describe('7.1 toolCountWarning', () => {
  const summary = (id: string, toolCount: number) => ({
    id,
    slug: id,
    displayName: `Name ${id}`,
    toolCount,
    promptCount: 0,
    resourceCount: 0,
    collisionCount: 0,
    degraded: false,
  });
  const ep = (count: number, installations = [summary('a', count)]) =>
    ({ tools: Array.from({ length: count }, (_, i) => tool(`t${i}`)), installations }) as Pick<
      EffectiveEndpoint,
      'tools' | 'installations'
    >;

  it('7.1 defaults to a threshold of 40 and warns only above it', () => {
    expect(DEFAULT_TOOL_WARN_THRESHOLD).toBe(40);
    expect(toolCountWarning(ep(40)).exceeded).toBe(false);
    expect(toolCountWarning(ep(40)).actions).toEqual([]);
    const over = toolCountWarning(ep(41));
    expect(over).toMatchObject({ count: 41, threshold: 40, exceeded: true });
    expect(over.actions).toEqual(['split_endpoint', 'hide_tools']);
  });

  it('7.1 honours a custom threshold', () => {
    expect(toolCountWarning(ep(3), 2).exceeded).toBe(true);
    expect(toolCountWarning(ep(3), 3).exceeded).toBe(false);
  });

  it('7.1 lists installations with tools, largest first, ties by id', () => {
    const out = toolCountWarning(
      ep(0, [summary('c', 2), summary('b', 5), summary('a', 5), summary('z', 0)]),
    );
    expect(out.byInstallation.map((i) => i.installationId)).toEqual(['a', 'b', 'c']);
    expect(out.byInstallation[0]).toEqual({
      installationId: 'a',
      displayName: 'Name a',
      toolCount: 5,
    });
  });
});

describe('7.3 collisionWarnings', () => {
  it('7.3 shows each collision on every installation involved', () => {
    const c1 = { kind: 'tool' as const, name: 'search', installationIds: ['a', 'b'] };
    const c2 = { kind: 'prompt' as const, name: 'review', installationIds: ['b', 'c'] };
    const out = collisionWarnings({ collisions: [c1, c2] });
    expect(out.get('a')).toEqual([c1]);
    expect(out.get('b')).toEqual([c1, c2]);
    expect(out.get('c')).toEqual([c2]);
    expect(out.has('d')).toBe(false);
  });

  it('7.3 is empty without collisions', () => {
    expect(collisionWarnings({ collisions: [] }).size).toBe(0);
  });
});
