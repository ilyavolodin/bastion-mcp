import { describe, expect, it } from 'vitest';
import {
  buildUriIndex,
  extractSeenUris,
  InMemorySeenUriStore,
  RedisSeenUriStore,
  ResourceNotFoundError,
  resolveResourceUri,
  resolveResourceUriWithSeen,
  type UriIndexInput,
} from '../src/uri-index';

const base: UriIndexInput = { resources: [], templates: [], seen: [], rewritten: [] };

describe('7.4 URI index', () => {
  it('7.4 Exact: routes a listed URI to its installation', () => {
    const { index } = buildUriIndex({
      ...base,
      resources: [
        {
          installationId: 'a',
          advertisedUri: 'file:///x',
          upstreamUri: 'file:///x',
          route: { kind: 'resource' },
        },
      ],
    });
    expect(resolveResourceUri(index, 'file:///x')).toEqual({
      ok: true,
      target: { installationId: 'a', upstreamUri: 'file:///x' },
    });
  });

  it('7.4 Exact: the higher-priority installation owns duplicates and the loser is hidden and warned', () => {
    const r = (id: string) => ({
      installationId: id,
      advertisedUri: 'file:///x',
      upstreamUri: 'file:///x',
      route: { kind: 'resource' } as const,
    });
    const { index, conflicts, hiddenKeys } = buildUriIndex({
      ...base,
      resources: [r('a'), r('b')],
    });
    expect(resolveResourceUri(index, 'file:///x')).toMatchObject({
      target: { installationId: 'a' },
    });
    expect(conflicts).toEqual([{ uri: 'file:///x', owner: 'a', hidden: 'b' }]);
    expect(hiddenKeys.has('b\0file:///x')).toBe(true);
  });

  it('7.4 Seen: static tool _meta.ui.resourceUri entries route', () => {
    const { index } = buildUriIndex({ ...base, seen: [{ installationId: 'a', uri: 'ui://w' }] });
    expect(resolveResourceUri(index, 'ui://w')).toMatchObject({
      ok: true,
      target: { installationId: 'a' },
    });
  });

  it('7.4 Template: matches templates in endpoint order and honors pinned variables', () => {
    const { index } = buildUriIndex({
      ...base,
      templates: [
        {
          installationId: 'a',
          advertised: 'repo://acme/{repo}',
          route: {
            kind: 'template',
            upstreamTemplate: 'repo://{owner}/{repo}',
            pinnedVariables: { owner: 'acme' },
          },
        },
        {
          installationId: 'b',
          advertised: 'repo://{owner}/{repo}',
          route: {
            kind: 'template',
            upstreamTemplate: 'repo://{owner}/{repo}',
            pinnedVariables: {},
          },
        },
      ],
    });
    expect(resolveResourceUri(index, 'repo://acme/x')).toMatchObject({
      target: { installationId: 'a' },
    });
    expect(resolveResourceUri(index, 'repo://other/x')).toMatchObject({
      target: { installationId: 'b' },
    });
    expect(resolveResourceUri(index, 'nope://x')).toEqual({ ok: false });
  });

  it('7.4 Rewritten: bastion+{slug}: routes directly with the prefix stripped', () => {
    const { index } = buildUriIndex({
      ...base,
      rewritten: [{ slug: 'fs-a', installationId: 'a' }],
    });
    expect(resolveResourceUri(index, 'bastion+fs-a:file:///x')).toEqual({
      ok: true,
      target: { installationId: 'a', upstreamUri: 'file:///x' },
    });
    expect(resolveResourceUri(index, 'bastion+fs-z:file:///x')).toEqual({ ok: false });
  });

  it('7.4 Exact with prefix strips it upstream; a pinned-variable violation is a miss', () => {
    const { index } = buildUriIndex({
      ...base,
      resources: [
        {
          installationId: 'a',
          advertisedUri: 'bastion+fs-a:file:///x',
          upstreamUri: 'file:///x',
          route: { kind: 'resource', prefixSlug: 'fs-a' },
        },
      ],
      templates: [
        {
          installationId: 'a',
          advertised: 'repo://acme/{repo}',
          route: {
            kind: 'template',
            upstreamTemplate: 'repo://{owner}/{repo}',
            pinnedVariables: { owner: 'zzz' },
          },
        },
      ],
    });
    expect(resolveResourceUri(index, 'bastion+fs-a:file:///x')).toMatchObject({
      target: { upstreamUri: 'file:///x' },
    });
    expect(resolveResourceUri(index, 'repo://acme/x')).toEqual({ ok: false });
  });

  it('6.9 a miss is -32602 resource not found', () => {
    expect(new ResourceNotFoundError('x://y').mcpCode).toBe(-32602);
  });
});

describe('7.4 Seen URI store', () => {
  it('7.4 extracts resource_link, embedded resource and _meta.ui.resourceUri', () => {
    expect(
      extractSeenUris({
        content: [
          { type: 'resource_link', uri: 'a://1' },
          { type: 'resource', resource: { uri: 'a://2', text: 't' } },
          { type: 'text', text: 'x' },
          'junk',
        ],
        _meta: { ui: { resourceUri: 'ui://3' } },
      }).sort(),
    ).toEqual(['a://1', 'a://2', 'ui://3']);
    expect(extractSeenUris(null)).toEqual([]);
  });

  it('7.4 falls back to the seen store after the sync index misses', async () => {
    const store = new InMemorySeenUriStore();
    await store.record('p', 'e', [{ uri: 'a://1', installationId: 'inst' }]);
    const { index } = buildUriIndex(base);
    const ctx = { store, principalId: 'p', endpointId: 'e' };
    expect(await resolveResourceUriWithSeen(index, 'a://1', ctx)).toEqual({
      ok: true,
      target: { installationId: 'inst', upstreamUri: 'a://1' },
    });
    expect(await resolveResourceUriWithSeen(index, 'a://2', ctx)).toEqual({ ok: false });
    expect(await resolveResourceUriWithSeen(index, 'a://1', { ...ctx, principalId: 'q' })).toEqual({
      ok: false,
    });
    const hit = buildUriIndex({ ...base, seen: [{ installationId: 'z', uri: 'a://1' }] }).index;
    expect(await resolveResourceUriWithSeen(hit, 'a://1', ctx)).toMatchObject({ ok: true });
  });

  it('7.4 the Redis adapter writes uriseen:{principal}:{endpoint} with a 24 h TTL', async () => {
    const calls: unknown[] = [];
    const store = new RedisSeenUriStore({
      hset: async (k, v) => calls.push(['hset', k, v]),
      expire: async (k, s) => calls.push(['expire', k, s]),
      hget: async (_k, f) => (f === 'a://1' ? 'inst' : null),
    });
    await store.record('p', 'e', []);
    await store.record('p', 'e', [{ uri: 'a://1', installationId: 'inst' }]);
    expect(calls).toEqual([
      ['hset', 'uriseen:p:e', { 'a://1': 'inst' }],
      ['expire', 'uriseen:p:e', 86400],
    ]);
    expect(await store.lookup('p', 'e', 'a://1')).toBe('inst');
    expect(await store.lookup('p', 'e', 'zz')).toBeNull();
  });
});
