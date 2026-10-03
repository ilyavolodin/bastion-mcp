import {
  BastionError,
  GuardBlockedError,
  QuotaExceededError,
  RateLimitedError,
} from '@bastion-mcp/core';
import type { GuardRunResult } from '@bastion-mcp/guards';
import { EndpointCache } from '@bastion-mcp/router';
import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { LegacySessionStore, newSessionId } from '../src/adapters/legacy/sessions';
import {
  baseOpContext,
  first,
  inputRequiredPayload,
  isLegacyVersion,
  isModernVersion,
  sendResponse,
  sseCommentFrame,
  sseMessageFrame,
} from '../src/adapters/shared';
import { fullyLocal, inputKindOf, partitionInputRequests } from '../src/bridge/partition';
import { EndpointResolver, NEGATIVE_TTL_MS } from '../src/http/resolver';
import type { CallRecord } from '../src/observability/call-log';
import { defaultToPolicyPrincipal } from '../src/operations/deps';
import { callMetricLabels, runRoutedOperation, spanStatusFor } from '../src/operations/outcome';
import { decideConfirm, limitsRejectionLabels } from '../src/operations/routed';
import {
  applyGuardResult,
  needsInstallationVariables,
  runGuards,
  wallClock,
} from '../src/operations/support';
import { noopLogger } from '../src/ports';
import { FakeRedis } from './helpers/fake-redis';
import {
  allowAllPolicy,
  buildEndpoint,
  installation,
  items,
  opContext,
  principal,
  requestContext,
} from './helpers/fixtures';
import { makeOps } from './helpers/ops';

describe('6.5 input request partitioning', () => {
  const entries = {
    e: {
      method: 'elicitation/create',
      params: { mode: 'form', message: 'm', requestedSchema: {} },
    },
    s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } },
    r: { method: 'roots/list', params: {} },
  };

  it('6.5 maps methods to kinds and ignores unknown methods', () => {
    expect(inputKindOf('elicitation/create')).toBe('elicitation');
    expect(inputKindOf('sampling/createMessage')).toBe('sampling');
    expect(inputKindOf('roots/list')).toBe('roots');
    expect(inputKindOf('x/y')).toBeUndefined();
  });

  it('6.5 a client without capabilities gets nothing: elicitation declines, sampling errors -32601, roots are the configured ones', () => {
    const p = partitionInputRequests(entries, {}, ['file:///work']);
    expect(p.forClient).toEqual({});
    expect(p.local.e).toEqual({ action: 'decline' });
    expect(p.local.s).toMatchObject({ error: { code: -32601 } });
    expect(JSON.stringify(p.local.r)).toContain('file:///work');
    expect(fullyLocal(p)).toBe(true);
  });

  it('6.5 capabilities the client declared keep the request for the client', () => {
    const p = partitionInputRequests(
      entries,
      { elicitation: { form: {} }, sampling: {}, roots: {} },
      [],
    );
    expect(Object.keys(p.forClient).sort()).toEqual(['e', 'r', 's']);
    expect(p.local).toEqual({});
    expect(fullyLocal(p)).toBe(false);
  });

  it('6.5 unknown methods go to the client; no requests at all is an empty partition', () => {
    const p = partitionInputRequests({ x: { method: 'x/y', params: {} } }, {}, []);
    expect(Object.keys(p.forClient)).toEqual(['x']);
    expect(partitionInputRequests(undefined, {}, [])).toEqual({ forClient: {}, local: {} });
  });
});

describe('6.2 legacy session store', () => {
  const setup = (maxPerPrincipal = 2) => {
    const redis = new FakeRedis();
    const store = new LegacySessionStore(redis, { maxPerPrincipal, now: () => redis.now });
    const create = (id: string, principalId = 'p1') =>
      store.create({
        id,
        principalId,
        tokenHash: 'h',
        endpointId: 'e',
        protocolVersion: '2025-11-25',
        clientCapabilities: {},
      });
    return { redis, store, create };
  };

  it('6.2 session ids are unguessable and distinct', () => {
    expect(newSessionId()).not.toBe(newSessionId());
    expect(newSessionId().length).toBeGreaterThanOrEqual(43);
  });

  it('6.2 beyond the per-principal cap the oldest idle session is evicted and its streams told to close', async () => {
    const { redis, store, create } = setup(2);
    redis.now = 1;
    await create('a');
    redis.now = 2;
    await create('b');
    redis.now = 3;
    await create('c');
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).not.toBeNull();
    expect(await store.get('c')).not.toBeNull();
    expect(redis.published.some((m) => m.message.includes('close'))).toBe(true);
  });

  it('6.2 touching a session makes it the most recent, so another one is evicted first', async () => {
    const { redis, store, create } = setup(2);
    redis.now = 1;
    const a = await create('a');
    redis.now = 2;
    await create('b');
    redis.now = 3;
    await store.touch(a);
    redis.now = 4;
    await create('c');
    expect(await store.get('b')).toBeNull();
    expect((await store.get('a'))?.lastSeenAt).toBe(3);
  });

  it('6.2 sessions of other principals do not count against the cap, and unusable ids read as absent', async () => {
    const { store, create } = setup(1);
    await create('a', 'p1');
    await create('b', 'p2');
    expect(await store.get('a')).not.toBeNull();
    expect(await store.get('')).toBeNull();
    expect(await store.get('x'.repeat(129))).toBeNull();
  });

  it('6.2 log level and subscriptions are stored on the session', async () => {
    const { store, create } = setup();
    await create('a');
    await store.setLogLevel('a', 'warning');
    await store.setSubs('a', ['test://x']);
    expect(await store.get('a')).toMatchObject({ logLevel: 'warning', subs: ['test://x'] });
    await store.setLogLevel('a', 'not-a-level');
    expect((await store.get('a'))?.logLevel).toBeUndefined();
  });
});

describe('10.3 wall clock for Cedar', () => {
  const cases: [string, string, { hour: number; weekday: number }][] = [
    ['UTC', '2026-01-02T23:30:00Z', { hour: 23, weekday: 5 }],
    ['Asia/Tokyo', '2026-01-02T23:30:00Z', { hour: 8, weekday: 6 }],
    // New York: DST starts 2026-03-08 at 02:00 local (07:00 UTC).
    ['America/New_York', '2026-03-08T06:59:00Z', { hour: 1, weekday: 0 }],
    ['America/New_York', '2026-03-08T07:00:00Z', { hour: 3, weekday: 0 }],
    // DST ends 2026-11-01 at 02:00 EDT: 05:30 UTC is 01:30 EDT, 06:30 UTC is 01:30 EST.
    ['America/New_York', '2026-11-01T05:30:00Z', { hour: 1, weekday: 0 }],
    ['America/New_York', '2026-11-01T06:30:00Z', { hour: 1, weekday: 0 }],
    ['America/New_York', '2026-11-01T07:30:00Z', { hour: 2, weekday: 0 }],
    // Midnight is hour 0 (h23), not 24.
    ['Europe/Berlin', '2026-06-30T22:00:00Z', { hour: 0, weekday: 3 }],
  ];
  it.each(cases)('10.3 %s at %s', (zone, iso, expected) => {
    expect(wallClock(Date.parse(iso), zone)).toEqual(expected);
  });

  it('10.3 more distinct zones than the memo holds still answer correctly', () => {
    const at = Date.parse('2026-01-02T12:00:00Z');
    for (let offset = -12; offset <= 12; offset += 1) {
      const zone = `Etc/GMT${offset >= 0 ? '+' : '-'}${Math.abs(offset)}`;
      // Etc/GMT+5 is UTC-5.
      expect(wallClock(at, zone).hour).toBe((12 - offset + 24) % 24);
    }
    for (const region of ['Europe/Paris', 'Europe/Rome', 'Asia/Dubai', 'Asia/Kolkata']) {
      for (let i = 0; i < 20; i += 1) wallClock(at, region);
    }
  });
});

describe('13.2 guard results', () => {
  const base: GuardRunResult = {
    action: 'allow',
    findings: [],
    redactions: [],
    records: [],
    truncated: false,
    asyncSettled: Promise.resolve(),
  };
  const segments = [{ path: ['arguments', 'q'], text: 'secret' }] as never;

  it('13.2 a block fails the operation as GUARD_BLOCKED', () => {
    const run = {
      ...base,
      action: 'block',
      block: { guard: 'g', ruleId: 'r', label: 'l' },
    } as GuardRunResult;
    expect(() => applyGuardResult(run, {}, segments)).toThrow(GuardBlockedError);
  });

  it('13.2 an allow leaves the payload alone and adds no _meta', () => {
    const root = { arguments: { q: 'secret' } };
    expect(applyGuardResult(base, root, segments)).toEqual({ value: root, meta: {} });
  });

  it('13.2 a warn adds the guard _meta entry', () => {
    const run = {
      ...base,
      action: 'warn',
      findings: [{ action: 'warn', guard: 'g', finding: { label: 'l', verdict: 'suspicious' } }],
    } as unknown as GuardRunResult;
    const applied = applyGuardResult(run, { a: 1 }, segments);
    expect(Object.keys(applied.meta)).toHaveLength(1);
  });

  it('13.2 runGuards evaluates with the configured layers and lays spans out from the injected clock', async () => {
    const seen: { input?: { phase: string; method: string }; layers?: unknown } = {};
    const spans: unknown[] = [];
    const run = {
      ...base,
      records: [
        {
          type: 'regex',
          guard: 'g1',
          phase: 'request',
          verdict: 'clean',
          action: 'allow',
          latencyMs: 4,
        },
      ],
    } as unknown as GuardRunResult;
    const deps = {
      guards: {
        run: async (input: { phase: string; method: string }, layers: unknown) => {
          seen.input = input;
          seen.layers = layers;
          return run;
        },
      },
      guardProfiles: { layersFor: (q: unknown) => ({ requested: q }) },
      tracer: {
        startSpan: (name: string, o: { startTime: number }) => {
          spans.push({ name, start: o.startTime });
          return { setStatus: () => undefined, end: (t: number) => spans.push({ end: t }) };
        },
      },
      clock: { now: () => 1000 },
    };
    const inst = installation('a');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const result = await runGuards(
      deps as never,
      opContext(resolved),
      'request',
      { installation: inst, item: { kind: 'tool', name: 'echo' }, method: 'tools/call' },
      segments,
      'profile-1',
    );
    expect(result).toBe(run);
    expect(seen.input).toMatchObject({ phase: 'request', method: 'tools/call' });
    expect(JSON.stringify(seen.layers)).toContain('profile-1');
    expect(spans).toContainEqual({ name: expect.stringContaining('regex'), start: 1000 });
    expect(spans).toContainEqual({ end: 1004 });
  });
});

describe('15.2 operation outcome recording', () => {
  it('15.3 metric labels name the catalog entry by slug, else id, else unknown', () => {
    const rec = { outcome: 'ok' } as const;
    expect(callMetricLabels(rec, installation('a', { catalogSlug: 'github' }))).toEqual({
      'bastion.catalog.entry': 'github',
      outcome: 'ok',
    });
    const inst = installation('b');
    expect(callMetricLabels(rec, inst)['bastion.catalog.entry']).toBe(inst.catalogEntryId);
    expect(callMetricLabels(rec, undefined)['bastion.catalog.entry']).toBe('unknown');
  });

  it('15.2 only error, denied and blocked outcomes mark the span as failed', () => {
    expect(spanStatusFor({ outcome: 'ok', errorCode: undefined })).toBeUndefined();
    expect(spanStatusFor({ outcome: 'tool_error', errorCode: undefined })).toBeUndefined();
    expect(spanStatusFor({ outcome: 'rate_limited', errorCode: undefined })).toBeUndefined();
    expect(spanStatusFor({ outcome: 'denied', errorCode: 'POLICY_DENIED' })).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'POLICY_DENIED',
    });
    expect(spanStatusFor({ outcome: 'blocked', errorCode: undefined })).toMatchObject({
      message: 'blocked',
    });
  });

  it('15.5 runRoutedOperation writes one row for a failure and rethrows it', async () => {
    const inst = installation('a');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const ops = makeOps();
    await expect(
      runRoutedOperation(ops.deps, opContext(resolved), 'tools/call', inst, async () => {
        throw new BastionError('POLICY_DENIED', 'no', { httpStatus: 403 });
      }),
    ).rejects.toThrow('no');
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({ outcome: 'denied', method: 'tools/call' });
  });

  it('15.5 onError may turn a failure into a result; the row still records the failure', async () => {
    const inst = installation('a');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const ops = makeOps();
    const result = await runRoutedOperation(
      ops.deps,
      opContext(resolved),
      'tools/call',
      inst,
      async () => {
        throw new BastionError('POLICY_DENIED', 'no', { httpStatus: 403 });
      },
      { onError: () => ({ kind: 'complete' as const, result: { isError: true } }) },
    );
    expect(result).toEqual({ kind: 'complete', result: { isError: true } });
    expect(ops.rows[0]?.outcome).toBe('denied');
  });

  it('15.5 a successful body gets a record primed with the installation and the item name', async () => {
    const inst = installation('a');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const ops = makeOps();
    const seen: CallRecord[] = [];
    await runRoutedOperation(
      ops.deps,
      opContext(resolved),
      'prompts/get',
      inst,
      async (record) => {
        seen.push(record);
        return 1;
      },
      { itemName: 'greet' },
    );
    expect(seen[0]).toMatchObject({ installationId: inst.id, itemName: 'greet' });
    expect(ops.rows[0]).toMatchObject({ outcome: 'ok' });
  });
});

describe('13.2 routed pipeline decisions', () => {
  it('13.2 a confirm verdict is satisfied by an approval, otherwise asks or blocks by what the client can do', () => {
    expect(decideConfirm(undefined, false, true)).toBe('proceed');
    expect(decideConfirm({ guard: 'g', reason: 'r' }, true, false)).toBe('proceed');
    expect(decideConfirm({ guard: 'g', reason: 'r' }, false, true)).toBe('ask');
    expect(decideConfirm({ guard: 'g', reason: 'r' }, false, false)).toBe('block');
  });

  it('14.2 limit rejections are labelled with the rule and the kind', () => {
    expect(
      limitsRejectionLabels(new QuotaExceededError('q', { resetsAt: 'x', quota: 'daily' })),
    ).toEqual({ rule: 'daily', kind: 'quota' });
    expect(
      limitsRejectionLabels(
        new RateLimitedError('Too many calls', { retryAfterMs: 1, limit: 'burst' }),
      ),
    ).toEqual({ rule: 'burst', kind: 'rate' });
    expect(
      limitsRejectionLabels(
        new RateLimitedError('Concurrency limit "c" reached', {
          retryAfterMs: 1,
          limit: 'c',
          kind: 'concurrency',
        }),
      ),
    ).toEqual({ rule: 'c', kind: 'concurrency' });
  });

  it('12.4 variables are loaded only when a pinned value holds a template', () => {
    expect(needsInstallationVariables(undefined)).toBe(false);
    expect(needsInstallationVariables({})).toBe(false);
    expect(needsInstallationVariables({ pinned: { a: 'plain' } })).toBe(false);
    expect(needsInstallationVariables({ pinned: { a: '{{var.x}}' } })).toBe(true);
    expect(needsInstallationVariables({ pinned: { a: { deep: ['{{user.id}}'] } } })).toBe(true);
  });
});

describe('6.2 adapter helpers', () => {
  it('6.2 versions are recognized per era', () => {
    expect(isLegacyVersion('2025-11-25')).toBe(true);
    expect(isLegacyVersion('2026-07-28')).toBe(false);
    expect(isLegacyVersion(undefined)).toBe(false);
    expect(isModernVersion('2026-07-28')).toBe(true);
    expect(isModernVersion('2025-11-25')).toBe(false);
  });

  it('6.2 header lists collapse to their first value; SSE frames carry message events and comments', () => {
    expect(first(['a', 'b'])).toBe('a');
    expect(first('c')).toBe('c');
    expect(first(undefined)).toBeUndefined();
    expect(sseMessageFrame({ a: 1 })).toBe('event: message\ndata: {"a":1}\n\n');
    expect(sseCommentFrame('keepalive')).toBe(': keepalive\n\n');
  });

  it('6.5 the input_required payload omits absent inputRequests', () => {
    expect(inputRequiredPayload({ requestState: 's' })).toEqual({ requestState: 's' });
    const inputRequests = { b0: { method: 'roots/list', params: {} } };
    expect(inputRequiredPayload({ inputRequests, requestState: 's' })).toEqual({
      inputRequests,
      requestState: 's',
    });
  });

  it('6.2 sendResponse writes JSON or an empty status, and only ends a response whose headers are out', () => {
    const make = (headersSent: boolean) => {
      const log: unknown[] = [];
      return {
        log,
        res: {
          headersSent,
          writeHead: (...a: unknown[]) => log.push(['head', ...a]),
          end: (...a: unknown[]) => log.push(['end', ...a]),
        },
      };
    };
    const json = make(false);
    sendResponse(json.res as never, 200, { a: 1 }, { 'x-h': '1' });
    expect(json.log[0]).toEqual([
      'head',
      200,
      { 'content-type': 'application/json', 'content-length': 7, 'x-h': '1' },
    ]);
    expect(json.log[1]).toEqual(['end', '{"a":1}']);
    const empty = make(false);
    sendResponse(empty.res as never, 202);
    expect(empty.log).toEqual([['head', 202, {}], ['end']]);
    const sent = make(true);
    sendResponse(sent.res as never, 200, { a: 1 });
    expect(sent.log).toEqual([['end']]);
  });

  it('6.2 both adapters build the shared part of the context from the authenticated request', async () => {
    const inst = installation('a');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const rc = requestContext(resolved);
    const ctx = baseOpContext(rc, {
      era: 'modern',
      protocolVersion: '2026-07-28',
      clientCapabilities: {},
      trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 },
      signal: new AbortController().signal,
      emit: () => undefined,
      requestId: 7,
    });
    expect(ctx).toMatchObject({
      era: 'modern',
      requestId: 7,
      principal: rc.principal,
      endpoint: resolved.endpoint,
      origin: rc.origin,
      ip: rc.ip,
      path: rc.path,
    });
  });
});

describe('7.2 endpoint resolver negative cache', () => {
  it('7.2 an unknown slug is remembered for the negative TTL on the injected clock, then loaded again', async () => {
    let now = 1_000;
    let loads = 0;
    const inst = installation('a');
    const resolver = new EndpointResolver({
      data: {
        configVersion: () => '1',
        load: async () => {
          loads += 1;
          return { installations: [inst], namedEndpoints: [] };
        },
      },
      cache: new EndpointCache(),
      source: { listItems: async () => ({ status: 'ok', items: items(), origin: 'live' }) },
      policy: { current: () => allowAllPolicy },
      toPolicyPrincipal: defaultToPolicyPrincipal,
      org: { displayName: 'Acme' },
      serverVersion: '1',
      clock: { now: () => now },
      logger: noopLogger,
    });
    const req = {
      clientId: 'c',
      clientName: '',
      ip: '127.0.0.1',
      authMethod: 'oauth',
      path: '/mcp',
    };
    const slug = { kind: 'installation', slug: 'zzz' } as const;
    expect(await resolver.resolve(principal(), slug, req)).toBeNull();
    expect(loads).toBe(1);
    now += NEGATIVE_TTL_MS - 1;
    expect(await resolver.resolve(principal(), slug, req)).toBeNull();
    expect(loads).toBe(1);
    now += 1;
    expect(await resolver.resolve(principal(), slug, req)).toBeNull();
    expect(loads).toBe(2);
    // Another principal is not covered by the first one's negative entry.
    expect(
      await resolver.resolve(principal({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c' }), slug, req),
    ).toBeNull();
    expect(loads).toBe(3);
  });
});
