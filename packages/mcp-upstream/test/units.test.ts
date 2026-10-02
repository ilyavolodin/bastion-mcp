import {
  BastionError,
  MAX_LIST_ITEMS_PER_INSTALLATION,
  UpstreamAuthRequiredError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import type { SafeRemoteUrl } from '@bastion-mcp/sandbox';
import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { trace } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RemoteAgentRegistry } from '../src/connectors/agent';
import { CapTracker, lastEventBoundary, trackSseEvents } from '../src/connectors/caps';
import { EraCache } from '../src/connectors/era-cache';
import { resolveRemoteTarget, templateContextFor } from '../src/connectors/remote';
import {
  ContinuationLostError,
  mapUpstreamError,
  toRpcError,
  UpstreamRpcError,
} from '../src/errors';
import { RedisEgressPolicyStore } from '../src/instances/egress-store';
import { otelInstanceTelemetry } from '../src/instances/telemetry';
import { identityUriMapper, NotifyPublisher } from '../src/listen/events';
import { ListCache, Lru, ReadCache } from '../src/lists/cache';
import { readAllPages } from '../src/lists/source';
import { AuthRequiredError, type RedisLike } from '../src/ports';
import { toWireContext } from '../src/types';
import { FakeRedis } from './helpers/fake-redis';
import { credential, ctxOf, installationOf, principal, remoteSpec } from './helpers/fixtures';

describe('6.9 upstream error mapping', () => {
  const ctx = { installation: 'gh', timeoutMs: 60_000, connectUrl: () => 'https://b/connect/1' };

  it('6.9 upstream JSON-RPC errors pass through with their code, truncated to 2,000 characters without stack traces', async () => {
    const long = `${'x'.repeat(5000)}\n    at secret (file.js:1:1)`;
    const mapped = await mapUpstreamError(new ProtocolError(-32602, long, { field: 'a' }), ctx);
    expect(mapped).toBeInstanceOf(UpstreamRpcError);
    expect(mapped.mcpCode).toBe(-32602);
    expect(mapped.message.length).toBeLessThanOrEqual(2000);
    expect(mapped.message).not.toContain('at secret');
    expect((mapped as UpstreamRpcError).rpcData).toEqual({ field: 'a' });
  });

  it('6.9 timeouts become UPSTREAM_TIMEOUT -32017 with the timeout', async () => {
    const mapped = await mapUpstreamError(
      new SdkError(SdkErrorCode.RequestTimeout, 'timed out'),
      ctx,
    );
    expect(mapped).toBeInstanceOf(UpstreamTimeoutError);
    expect(mapped.data).toEqual({ installation: 'gh', timeoutMs: 60_000 });
    const unknown = await mapUpstreamError(new SdkError(SdkErrorCode.RequestTimeout, 'x'), {
      installation: 'gh',
    });
    expect(unknown.data.timeoutMs).toBe(0);
  });

  it('6.5 a missing or rejected credential becomes UPSTREAM_AUTH_REQUIRED -32015 with the connect URL', async () => {
    for (const error of [
      new AuthRequiredError(),
      new UnauthorizedError('no'),
      new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'nope', { status: 401 }),
      new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'nope', { status: 403 }),
    ]) {
      const mapped = await mapUpstreamError(error, ctx);
      expect(mapped).toBeInstanceOf(UpstreamAuthRequiredError);
      expect(mapped.data.connectUrl).toBe('https://b/connect/1');
    }
    const noUrl = await mapUpstreamError(new AuthRequiredError(), { installation: 'gh' });
    expect(noUrl.data.connectUrl).toBe('');
  });

  it('6.9 everything else is UPSTREAM_UNAVAILABLE -32014', async () => {
    for (const error of [
      new SdkError(SdkErrorCode.ConnectionClosed, 'closed'),
      new Error('boom'),
      'a string',
      new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'bad gateway', { status: 502 }),
    ]) {
      const mapped = await mapUpstreamError(error, ctx);
      expect(mapped).toBeInstanceOf(UpstreamUnavailableError);
      expect(mapped.mcpCode).toBe(-32014);
    }
  });

  it('6.9 BastionErrors are returned as they are and coded plain errors count as upstream errors', async () => {
    const own = new ContinuationLostError('gh');
    expect(await mapUpstreamError(own, ctx)).toBe(own);
    expect(own.mcpCode).toBe(-32014);
    const coded = await mapUpstreamError({ code: -32001, message: 'custom' }, ctx);
    expect(coded).toBeInstanceOf(UpstreamRpcError);
    expect(coded.mcpCode).toBe(-32001);
    expect(toRpcError(coded)).toEqual({ code: -32001, message: 'custom' });
    expect(toRpcError(new BastionError('X', 'plain', { httpStatus: 500 }))).toEqual({
      code: -32603,
      message: 'plain',
    });
  });
});

describe('8.9 response caps', () => {
  const sse = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { 'content-type': 'text/event-stream', ...headers } });

  it('8.9 finds the end of the last SSE event', () => {
    expect(lastEventBoundary(Buffer.from('data: a\n\ndata: b'))).toBe(9);
    expect(lastEventBoundary(Buffer.from('data: a\r\n\r\n'))).toBe(11);
    expect(lastEventBoundary(Buffer.from('no boundary'))).toBe(-1);
  });

  it('8.9 measures SSE events even when a terminator is split across chunks', () => {
    const empty = { pending: 0, carry: Buffer.alloc(0) };
    const one = trackSseEvents(empty, Buffer.from('data: 12345\n'));
    expect(one.pending).toBe(12);
    // The second newline arrives in the next chunk: the event ends there and is 13 bytes.
    const two = trackSseEvents(one, Buffer.from('\ndata: x'));
    expect(two.largest).toBe(13);
    expect(two.pending).toBe(7);
    const whole = trackSseEvents(empty, Buffer.from('data: a\n\ndata: bbbbbbbb\n\n'));
    expect(whole.largest).toBe(16);
    expect(whole.pending).toBe(0);
  });

  it('8.9 a declared content-length above 32 MiB fails with -32014 and is logged', async () => {
    const logged: string[] = [];
    const violations: unknown[] = [];
    const caps = new CapTracker({
      installation: 'gh',
      logger: { debug() {}, info() {}, warn() {}, error: (m) => void logged.push(m) },
      onViolation: (e) => violations.push(e),
    });
    const wrapped = caps.wrap(
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': String(33 * 1024 * 1024) },
      }),
    );
    await expect(wrapped.text()).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(caps.violation?.mcpCode).toBe(-32014);
    expect(logged).toEqual(['upstream response cap exceeded']);
    expect(violations).toHaveLength(1);
  });

  it('8.9 a JSON body that grows past the per-message cap is cut off', async () => {
    const caps = new CapTracker({ installation: 'gh', messageBytes: 100 });
    const wrapped = caps.wrap(
      new Response('x'.repeat(500), { headers: { 'content-type': 'application/json' } }),
    );
    await expect(wrapped.text()).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('8.9 an SSE stream may carry many small events but no single one over the message cap', async () => {
    const small = new CapTracker({ installation: 'gh', messageBytes: 100, streamBytes: 10_000 });
    const events = Array.from({ length: 50 }, () => `data: ${'y'.repeat(40)}\n\n`).join('');
    await expect(small.wrap(sse(events)).text()).resolves.toBe(events);
    const big = new CapTracker({ installation: 'gh', messageBytes: 100, streamBytes: 10_000 });
    await expect(big.wrap(sse(`data: ${'z'.repeat(500)}\n\n`)).text()).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('8.9 a stream above 100 MiB (here 1 KiB) total fails', async () => {
    const caps = new CapTracker({ installation: 'gh', messageBytes: 400, streamBytes: 1024 });
    const events = Array.from({ length: 100 }, () => `data: ${'q'.repeat(30)}\n\n`).join('');
    await expect(caps.wrap(sse(events)).text()).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(caps.violation?.message).toContain('stream');
  });

  it('8.9 bodies without a stream and null bodies pass untouched', async () => {
    const caps = new CapTracker({ installation: 'gh' });
    expect(await caps.wrap(new Response('ok')).text()).toBe('ok');
    const empty = new Response(null, { status: 204 });
    expect(caps.wrap(empty).status).toBe(204);
  });
});

describe('8.9 per-installation undici agents', () => {
  const safe = (address: string): SafeRemoteUrl => ({
    url: new URL('https://x.example/mcp'),
    address,
    family: 4,
    port: 443,
  });

  it('8.9 reuses one agent per installation and address, replaces it when the address or certificate changes', async () => {
    const agents = new RemoteAgentRegistry();
    const a1 = agents.get('inst', safe('93.184.216.34'));
    expect(agents.get('inst', safe('93.184.216.34'))).toBe(a1);
    expect(agents.get('other', safe('93.184.216.34'))).not.toBe(a1);
    expect(agents.size).toBe(2);
    const a2 = agents.get('inst', safe('93.184.216.35'));
    expect(a2).not.toBe(a1);
    expect(agents.size).toBe(2);
    const withCa = agents.get('inst', safe('93.184.216.35'), { ca: '-----BEGIN CERTIFICATE-----' });
    expect(withCa).not.toBe(a2);
    await agents.closeInstallation('inst');
    expect(agents.size).toBe(1);
    await agents.closeAll();
    expect(agents.size).toBe(0);
  });
});

describe('6.4 era verdict cache', () => {
  it('6.4 stores the verdict for 24 hours and reads it back', async () => {
    const redis = new FakeRedis();
    const cache = new EraCache(redis);
    expect(await cache.get('i', 'c')).toBeUndefined();
    await cache.put('i', 'c', { kind: 'legacy' });
    expect(await cache.get('i', 'c')).toEqual({ kind: 'legacy' });
    const ttl = (redis.strings.get('era:i:c')?.expiresAt ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3_600_000);
    await cache.put('i', 'm', {
      kind: 'modern',
      discover: { supportedVersions: ['2026-07-28'] } as never,
    });
    expect(await cache.get('i', 'm')).toMatchObject({ kind: 'modern' });
    await cache.forget('i', 'c');
    expect(await cache.get('i', 'c')).toBeUndefined();
  });

  it('6.4 ignores garbage and survives a Redis outage (the first connection probes again)', async () => {
    const redis = new FakeRedis();
    const cache = new EraCache(redis);
    await redis.set('era:i:bad', 'not json');
    await redis.set('era:i:shape', JSON.stringify({ kind: 'modern' }));
    expect(await cache.get('i', 'bad')).toBeUndefined();
    expect(await cache.get('i', 'shape')).toBeUndefined();
    redis.failing = true;
    expect(await cache.get('i', 'x')).toBeUndefined();
    await expect(cache.put('i', 'x', { kind: 'legacy' })).resolves.toBeUndefined();
  });
});

describe('8.9 remote target resolution', () => {
  const settings = { privateCidrs: [], insecureHosts: ['localhost'] };
  const resolver = async () => ['93.184.216.34'];

  it('8.1 builds the template context from variable defaults, the user and credential secrets', () => {
    const inst = installationOf(
      remoteSpec('https://api.example.com/{{var.region}}', 'streamable-http', {
        variables: { region: { name: 'region', default: 'eu' } },
      }),
      { variables: { other: 'o' } },
    );
    const ctx = templateContextFor(inst, principal, {
      ...credential,
      templateContext: { secret: { K: 'v' }, oauth: { accessToken: 't' } },
    });
    expect(ctx.var).toEqual({ region: 'eu', other: 'o' });
    expect(ctx.user).toMatchObject({ id: 'user-1', email: 'ada@example.com', teams: ['eng'] });
    expect(ctx.secret).toEqual({ K: 'v' });
    expect(ctx.oauth?.accessToken).toBe('t');
  });

  it('8.9 resolves the URL and headers per user and rejects an unresolved reference with -32014', async () => {
    const good = installationOf(
      remoteSpec('https://api.example.com/{{var.region}}/mcp', 'streamable-http', {
        headers: [{ name: 'X-Team', value: '{{user.teams}}' }, { name: 'X-Plain' }],
      }),
      { variables: { region: 'us' } },
    );
    const target = await resolveRemoteTarget(good, principal, credential, {
      ...settings,
      resolver,
    });
    expect(target.url.pathname).toBe('/us/mcp');
    expect(target.headers).toEqual({ 'X-Team': 'eng' });
    const bad = installationOf(remoteSpec('https://api.example.com/{{var.missing}}'));
    await expect(
      resolveRemoteTarget(bad, principal, credential, { ...settings, resolver }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('8.9 custom CA and client certificate come from the spec tls secrets', async () => {
    const inst = installationOf(
      remoteSpec('https://api.example.com/mcp', 'streamable-http', {
        tls: { caBundleSecret: 'corp-ca', clientCertSecret: 'client-pem' },
      }),
    );
    const asked: string[] = [];
    const target = await resolveRemoteTarget(inst, principal, credential, {
      ...settings,
      resolver,
      tls: {
        resolve: async (name) => {
          asked.push(name);
          return `PEM(${name})`;
        },
      },
    });
    expect(asked).toEqual(['corp-ca', 'client-pem']);
    expect(target.tls).toEqual({
      ca: 'PEM(corp-ca)',
      cert: 'PEM(client-pem)',
      key: 'PEM(client-pem)',
    });
    await expect(
      resolveRemoteTarget(inst, principal, credential, { ...settings, resolver }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('8.9 a package spec is not a remote target', async () => {
    const inst = installationOf({ type: 'package' } as never);
    await expect(resolveRemoteTarget(inst, principal, credential, settings)).rejects.toThrow(
      'not a remote',
    );
  });
});

describe('6.7 caches', () => {
  it('6.7 the LRU evicts the least recently used entry', () => {
    const lru = new Lru<number>(3);
    for (const k of ['a', 'b', 'c']) lru.set(k, 1);
    expect(lru.get('a')).toBe(1); // a is now the freshest
    lru.set('d', 1);
    expect(lru.keys()).toEqual(['c', 'a', 'd']);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.delete('a')).toBe(true);
    expect(lru.size).toBe(2);
  });

  it('6.7 the per-worker list cache holds 10,000 entries', async () => {
    const redis = new FakeRedis();
    const cache = new ListCache({ redis });
    for (let i = 0; i < 10_050; i += 1)
      await cache.put(`inst-${i}`, 'c', 'tools/list', { items: [] });
    expect(cache.size).toBe(10_000);
  });

  it('6.7 uses the upstream ttlMs when present, else the default (300,000 ms), and never caches ttl 0', async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const redis = new FakeRedis();
    redis.now = () => now;
    const cache = new ListCache({ redis, clock });
    expect(cache.ttlFor(undefined)).toBe(300_000);
    expect(cache.ttlFor(5_000)).toBe(5_000);
    expect(new ListCache({ redis, defaultTtlMs: 10 }).ttlFor(undefined)).toBe(10);
    await cache.put('i', 'c', 'tools/list', { items: [1] });
    await cache.put('i', 'c', 'prompts/list', { items: [2], ttlMs: 5_000 });
    await cache.put('i', 'c', 'resources/list', { items: [3], ttlMs: 0 });
    expect(await cache.get('i', 'c', 'resources/list')).toBeNull();
    expect((await cache.get('i', 'c', 'tools/list'))?.items).toEqual([1]);
    now += 6_000;
    redis.now = () => now;
    expect(await cache.get('i', 'c', 'prompts/list')).toBeNull();
    expect((await cache.get('i', 'c', 'tools/list'))?.items).toEqual([1]);
    now += 300_000;
    redis.now = () => now;
    expect(await cache.get('i', 'c', 'tools/list')).toBeNull();
  });

  it('6.7 a second worker reads what the first wrote through Redis; malformed entries and outages read as a miss', async () => {
    const redis = new FakeRedis();
    const first = new ListCache({ redis });
    const second = new ListCache({ redis });
    await first.put('i', 'c', 'tools/list', {
      items: [{ name: 't' }],
      instructions: 'hi',
      serverInfo: { name: 's', version: '1' },
    });
    expect(await second.get('i', 'c', 'tools/list')).toMatchObject({
      instructions: 'hi',
      serverInfo: { name: 's' },
    });
    await redis.set('lc:i:c:prompts/list', '{"items": "nope"}');
    expect(await second.get('i', 'c', 'prompts/list')).toBeNull();
    await redis.set('lc:i:c:resources/list', 'garbage');
    expect(await second.get('i', 'c', 'resources/list')).toBeNull();
    redis.failing = true;
    expect(await new ListCache({ redis }).get('i', 'c', 'tools/list')).toBeNull();
    await expect(first.put('i', 'c', 'tools/list', { items: [] })).resolves.toBeUndefined();
  });

  it('6.7 invalidation deletes both layers', async () => {
    const redis = new FakeRedis();
    const cache = new ListCache({ redis });
    await cache.put('i', 'c', 'tools/list', { items: [] });
    await cache.put('i', 'd', 'tools/list', { items: [] });
    await cache.invalidate('i', 'c');
    expect(await redis.get('lc:i:c:tools/list')).toBeNull();
    expect(await redis.get('lc:i:d:tools/list')).not.toBeNull();
    await cache.invalidate('i');
    expect(await redis.get('lc:i:d:tools/list')).toBeNull();
    expect(await cache.get('i', 'd', 'tools/list')).toBeNull();
  });

  it('6.7 resources/read results are cached only with ttlMs > 0 and cacheScope public, keyed per installation', async () => {
    const redis = new FakeRedis();
    const reads = new ReadCache(redis);
    expect(ReadCache.cacheable({ ttlMs: 1000, cacheScope: 'public' })).toBe(1000);
    for (const result of [
      { ttlMs: 1000, cacheScope: 'private' },
      { ttlMs: 0, cacheScope: 'public' },
      { cacheScope: 'public' },
      { ttlMs: 1000 },
      'text',
      null,
    ]) {
      expect(ReadCache.cacheable(result)).toBeUndefined();
      expect(await reads.put('i', 'u://x', result)).toBe(false);
    }
    const cacheable = { contents: [], ttlMs: 60_000, cacheScope: 'public' };
    expect(await reads.put('i', 'u://x', cacheable)).toBe(true);
    expect(await reads.get('i', 'u://x')).toEqual(cacheable);
    // A different installation never sees it; a second worker finds it through Redis.
    expect(await reads.get('j', 'u://x')).toBeUndefined();
    expect(await new ReadCache(redis).get('i', 'u://x')).toEqual(cacheable);
    redis.failing = true;
    expect(await new ReadCache(redis).get('i', 'u://x')).toBeUndefined();
  });
});

describe('7.5 reading every page of an upstream list', () => {
  it('7.5 follows nextCursor until the end and keeps the smallest ttlMs', async () => {
    const pages: Record<string, { tools: number[]; nextCursor?: string; ttlMs?: number }> = {
      start: { tools: [1, 2], nextCursor: 'p2', ttlMs: 9000 },
      p2: { tools: [3], nextCursor: 'p3', ttlMs: 4000 },
      p3: { tools: [4] },
    };
    const seen: (string | undefined)[] = [];
    const out = await readAllPages(async (cursor) => {
      seen.push(cursor);
      return pages[cursor ?? 'start'] as never;
    }, 'tools');
    expect(out).toEqual({ items: [1, 2, 3, 4], truncated: false, ttlMs: 4000 });
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });

  it('7.5 caps an installation at 10,000 items and reports the truncation', async () => {
    let calls = 0;
    const out = await readAllPages(async () => {
      calls += 1;
      return { tools: Array.from({ length: 3000 }, (_, i) => i), nextCursor: 'more' };
    }, 'tools');
    expect(out.items).toHaveLength(MAX_LIST_ITEMS_PER_INSTALLATION);
    expect(out.truncated).toBe(true);
    expect(calls).toBe(4);
  });

  it('7.5 stops at a page limit when a server never ends its cursor chain', async () => {
    const out = await readAllPages(async () => ({ tools: [], nextCursor: 'again' }), 'tools');
    expect(out.truncated).toBe(true);
  });

  it('7.5 tolerates a missing or malformed list field', async () => {
    expect((await readAllPages(async () => ({}), 'tools')).items).toEqual([]);
    expect((await readAllPages(async () => ({ tools: 'oops' }), 'tools')).items).toEqual([]);
  });
});

describe('6.6 notification publishing', () => {
  it('6.6 publishes {targets, kind, uri?} on bastion:notify', async () => {
    const redis = new FakeRedis();
    const publisher = new NotifyPublisher(redis);
    const installation = installationOf(remoteSpec('https://a.example'), {
      ownerUserId: 'owner-1',
    });
    await publisher.listChanged(installation, ['tools', 'prompts', 'resources']);
    await publisher.resourceUpdated(installation, 'bastion+u://x', 'p-9');
    expect(redis.published.map((p) => p.channel)).toEqual(Array(4).fill('bastion:notify'));
    expect(redis.published.map((p) => JSON.parse(p.message))).toEqual([
      { targets: { principalIds: ['owner-1'] }, kind: 'tools_list_changed' },
      { targets: { principalIds: ['owner-1'] }, kind: 'prompts_list_changed' },
      { targets: { principalIds: ['owner-1'] }, kind: 'resources_list_changed' },
      { targets: { principalIds: ['p-9'] }, kind: 'resource_updated', uri: 'bastion+u://x' },
    ]);
  });

  it('6.6 targets: installation targets win, then the connection principal, then the owner', () => {
    const base = installationOf(remoteSpec('https://a.example'), { ownerUserId: null });
    expect(NotifyPublisher.targetsFor({ ...base, notifyTargets: { all: true } })).toEqual({
      all: true,
    });
    expect(NotifyPublisher.targetsFor(base, 'p1')).toEqual({ principalIds: ['p1'] });
    expect(NotifyPublisher.targetsFor(base)).toEqual({ all: false });
  });

  it('6.6 a Redis outage does not break the caller', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const publisher = new NotifyPublisher(redis);
    await expect(
      publisher.publish({ targets: { all: true }, kind: 'tools_list_changed' }),
    ).resolves.toBeUndefined();
  });

  it('7.4 the default URI mapper is the identity', () => {
    expect(identityUriMapper.toDownstream('i', 'u://x')).toEqual(['u://x']);
    expect(identityUriMapper.toUpstream('i', 'u://x')).toBe('u://x');
  });
});

describe('8.8 egress policy store', () => {
  it('8.8 round-trips {tokenSha256, allow, phase} through the Redis hash', async () => {
    const redis = new FakeRedis();
    const store = new RedisEgressPolicyStore(redis);
    expect(await store.get('i')).toBeNull();
    await store.set('i', {
      tokenSha256: 'ab',
      allow: ['a.com', '*.b.com:8443'],
      phase: 'installing',
    });
    expect(await store.get('i')).toEqual({
      tokenSha256: 'ab',
      allow: ['a.com', '*.b.com:8443'],
      phase: 'installing',
    });
    await store.set('i', { tokenSha256: 'ab', allow: ['a.com', '*.b.com:8443'], phase: 'running' });
    expect((await store.get('i'))?.phase).toBe('running');
    await redis.hset('egress:bad', { tokenSha256: 'x', allow: 'not json', phase: 'p' });
    expect(await store.get('bad')).toBeNull();
    await store.delete('i');
    expect(await store.get('i')).toBeNull();
  });
});

describe('15.2 instance acquisition span', () => {
  it('15.2 runs the function inside bastion.instance.acquire and passes the result through', async () => {
    const telemetry = otelInstanceTelemetry(trace.getTracer('test'));
    const events: string[] = [];
    const value = await telemetry.acquire({ 'bastion.instance.id': 'i' }, async (e) => {
      for (const name of ['claimed', 'bound', 'installed', 'spawned', 'connected'] as const) {
        e.add(name);
        events.push(name);
      }
      return 42;
    });
    expect(value).toBe(42);
    expect(events).toHaveLength(5);
    await expect(
      telemetry.acquire({}, async () => {
        throw new Error('start failed');
      }),
    ).rejects.toThrow('start failed');
  });
});

describe('21.2 wire context', () => {
  it('21.2 the wire context carries principal, capabilities, era, log level, trace and deadline but never the signal', () => {
    const wire = toWireContext(
      ctxOf({
        logLevel: 'info',
        deadlineAt: 99,
        endpointId: 'ep',
        downstreamName: 'x__y',
        singleInstallationEndpoint: true,
        signal: new AbortController().signal,
        emit: () => undefined,
        trace: { traceparent: 't' },
      }),
    );
    expect(Object.keys(wire).sort()).toEqual(
      [
        'clientCapabilities',
        'deadlineAt',
        'downstreamName',
        'endpointId',
        'era',
        'installationId',
        'logLevel',
        'principal',
        'singleInstallationEndpoint',
        'trace',
      ].sort(),
    );
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});

describe('5.4 the Redis port is satisfied by ioredis', () => {
  it('5.4 ioredis 5.x is assignable to RedisLike', () => {
    const assign = (client: Redis): RedisLike => client;
    expect(typeof assign).toBe('function');
    void vi;
  });
});
