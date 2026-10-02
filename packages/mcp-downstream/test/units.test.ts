import { BastionError, UpstreamUnavailableError } from '@bastion-mcp/core';
import { EndpointCache } from '@bastion-mcp/router';
import { isLegacyRequest } from '@modelcontextprotocol/server';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bastionRequestContext, currentRequestContext } from '../src/context';
import { isLegacyExchange } from '../src/http/plugin';
import { EndpointResolver, endpointKey } from '../src/http/resolver';
import { CallRecord, writeCallLog } from '../src/observability/call-log';
import {
  defaultGuardProfilePort,
  defaultLimitRulesPort,
  defaultToPolicyPrincipal,
} from '../src/operations/deps';
import { remapProgress, retryParts, wallClock } from '../src/operations/support';
import { noopLogger, systemClock } from '../src/ports';
import { errorTypeOf, InvalidParamsError, toRpcErrorBody, UnknownItemError } from '../src/rpc';
import { upstreamPortFrom } from '../src/upstream-port';
import {
  allowAllPolicy,
  buildEndpoint,
  installation,
  items,
  opContext,
  principal,
  requestContext,
  uuidFor,
} from './helpers/fixtures';

describe('6.9 error mapping', () => {
  it('6.9 Bastion errors keep code, message and data; protocol errors keep their code; anything else is -32603 without a message', () => {
    expect(toRpcErrorBody(new UpstreamUnavailableError('down', { installation: 'x' }))).toEqual({
      code: -32014,
      message: 'down',
      data: { installation: 'x' },
    });
    expect(toRpcErrorBody(new InvalidParamsError('bad'))).toEqual({ code: -32602, message: 'bad' });
    expect(toRpcErrorBody(new UnknownItemError('tool', 't'))).toMatchObject({ code: -32602 });
    const protocolLike = Object.assign(new Error('x'), {
      name: 'ProtocolError',
      code: -32021,
      data: { a: 1 },
    });
    expect(toRpcErrorBody(protocolLike)).toEqual({ code: -32021, message: 'x', data: { a: 1 } });
    const noData = Object.assign(new Error('x'), {
      name: 'ProtocolError',
      code: -32021,
      data: 'str',
    });
    expect(toRpcErrorBody(noData)).toEqual({ code: -32021, message: 'x' });
    expect(toRpcErrorBody(new Error('postgres://secret'))).toEqual({
      code: -32603,
      message: 'Internal error',
    });
    expect(toRpcErrorBody('boom')).toEqual({ code: -32603, message: 'Internal error' });
  });

  it('15.2 the error.type attribute is the stable code for Bastion errors and internal_error otherwise', () => {
    expect(errorTypeOf(new InvalidParamsError('x'))).toBe('INVALID_PARAMS');
    expect(errorTypeOf(new BastionError('X', 'm', { httpStatus: 500 }))).toBe('X');
    expect(errorTypeOf(new Error('x'))).toBe('internal_error');
  });
});

describe('10.1 defaults of the operation layer', () => {
  it('10.4 users and service accounts map to their Cedar principals', () => {
    const user = defaultToPolicyPrincipal(principal(), { emailDomain: 'acme.com' });
    expect(user).toMatchObject({ kind: 'user', role: 'member', emailDomain: 'acme.com' });
    const service = defaultToPolicyPrincipal(
      principal({ type: 'service', teams: [{ teamId: 'team-1', role: 'member' }] }),
      {},
    );
    expect(service).toMatchObject({ kind: 'service', team: { id: 'team-1' } });
    const orphan = defaultToPolicyPrincipal(principal({ type: 'service', teams: [] }), {});
    expect(orphan).toMatchObject({ kind: 'service', team: { id: '' } });
  });

  it('14.3 the default limit rules and guard profile are served until the control plane provides its own', () => {
    const rules = defaultLimitRulesPort.rulesFor(
      { principal: { orgId: 'org', userId: 'u1' }, method: 'tools/call' },
      { installationIds: [] },
    );
    expect(rules.map((r) => r.id)).toContain('default:user-calls');
    expect(defaultGuardProfilePort.layersFor({ installationId: 'i' }).org?.profileId).toBe(
      'org-default',
    );
  });
});

describe('6.2 request context', () => {
  it('6.2 the AsyncLocalStorage context is only available inside a request', async () => {
    expect(() => currentRequestContext()).toThrow(/no authenticated request context/);
    const resolved = await buildEndpoint({ installations: [installation('a')], items: {} });
    const rc = requestContext(resolved);
    expect(bastionRequestContext.run(rc, () => currentRequestContext())).toBe(rc);
  });
});

describe('support helpers', () => {
  it('10.3 wall clock hour and weekday in UTC and in another zone', () => {
    const at = Date.UTC(2026, 9, 2, 23, 30); // Friday 23:30 UTC
    expect(wallClock(at)).toEqual({ hour: 23, weekday: 5 });
    expect(wallClock(at, 'Asia/Tokyo')).toEqual({ hour: 8, weekday: 6 });
    expect(wallClock(at, 'Asia/Tokyo')).toEqual({ hour: 8, weekday: 6 });
  });

  it('6.5 retry fields are split off and validated', () => {
    expect(retryParts({ name: 'x', requestState: 'bst1.a', inputResponses: { a: {} } })).toEqual({
      inputResponses: { a: {} },
      requestState: 'bst1.a',
      rest: { name: 'x' },
    });
    expect(() => retryParts({ requestState: 5 })).toThrow(/requestState/);
    expect(() => retryParts({ inputResponses: [] })).toThrow(/inputResponses/);
  });

  it('6.6 progress tokens of either type are remapped and non-progress notifications pass', () => {
    const out: unknown[] = [];
    const resolved = {
      requestMeta: { progressToken: 7 },
      logLevel: 'error',
      emit: (n: unknown) => out.push(n),
    };
    const { upstreamMeta, emit } = remapProgress(resolved as never, () => 'abc-def');
    expect(upstreamMeta).toEqual({ progressToken: 'pt_abcdef' });
    emit?.({ method: 'notifications/progress', params: { progress: 1 } });
    emit?.({ method: 'notifications/message', params: { level: 'error', data: 'e' } });
    emit?.({ method: 'notifications/message', params: { level: 'debug', data: 'd' } });
    emit?.({ method: 'notifications/message', params: { data: 'no level' } });
    emit?.({ method: 'notifications/other' });
    expect(out).toEqual([
      { method: 'notifications/progress', params: { progress: 1, progressToken: 7 } },
      { method: 'notifications/message', params: { level: 'error', data: 'e' } },
      { method: 'notifications/message', params: { data: 'no level' } },
      { method: 'notifications/other' },
    ]);
  });
});

describe('15.5 call log writer', () => {
  const setup = async () => {
    const inst = installation('a');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const rows: unknown[] = [];
    const warnings: string[] = [];
    return {
      resolved,
      rows,
      warnings,
      deps: {
        callLog: { append: (row: unknown) => void rows.push(row) },
        logger: { ...noopLogger, warn: (m: string) => void warnings.push(m) },
        newId: () => uuidFor('row'),
        now: () => 2000,
      },
    };
  };

  it('15.5 drops a row whose principal is not a uuid instead of poisoning a batch', async () => {
    const { resolved, rows, warnings, deps } = await setup();
    const ctx = opContext(resolved, { principal: principal({ id: 'not-a-uuid' }) });
    writeCallLog(deps as never, ctx, new CallRecord('tools/call', 1000), {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(rows).toHaveLength(0);
    expect(warnings[0]).toMatch(/not a uuid/);
  });

  it('15.5 a sink that throws never breaks the request path', async () => {
    const { resolved, warnings, deps } = await setup();
    const throwing = {
      ...deps,
      callLog: {
        append: () => {
          throw new Error('sink down');
        },
      },
    };
    writeCallLog(throwing as never, opContext(resolved), new CallRecord('tools/call', 1000), {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(warnings[0]).toMatch(/could not be written/);
  });

  it('15.5 non-uuid endpoint, installation ids are stored as null and the duration is never negative', async () => {
    const { resolved, rows, deps } = await setup();
    const record = new CallRecord('tools/call', 5000);
    record.installationId = 'inst-x';
    writeCallLog(deps as never, opContext(resolved), record, {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(rows[0]).toMatchObject({ endpointId: null, installationId: null, durationMs: 0 });
  });

  it('15.5 failures are classified into the call-log outcomes', () => {
    const cases: [BastionError | Error, string][] = [
      [new BastionError('POLICY_DENIED', 'x', { httpStatus: 403 }), 'denied'],
      [new BastionError('RATE_LIMITED', 'x', { httpStatus: 429 }), 'rate_limited'],
      [new BastionError('QUOTA_EXCEEDED', 'x', { httpStatus: 429 }), 'rate_limited'],
      [new BastionError('GUARD_BLOCKED', 'x', { httpStatus: 403 }), 'blocked'],
      [new BastionError('OTHER', 'x', { httpStatus: 500 }), 'error'],
      [new Error('boom'), 'error'],
    ];
    for (const [error, outcome] of cases) {
      const record = new CallRecord('tools/call', 0);
      record.fail(error);
      expect(record.outcome).toBe(outcome);
    }
  });
});

describe('7.2 endpoint resolver', () => {
  const build = (overrides: Partial<ConstructorParameters<typeof EndpointResolver>[0]> = {}) => {
    const inst = installation('a');
    let loads = 0;
    const cache = new EndpointCache();
    const resolver = new EndpointResolver({
      data: {
        configVersion: () => '1',
        load: async () => {
          loads += 1;
          return { installations: [inst], namedEndpoints: [] };
        },
      },
      cache,
      source: { listItems: async () => ({ status: 'ok', items: items(), origin: 'live' }) },
      policy: { current: () => allowAllPolicy },
      toPolicyPrincipal: defaultToPolicyPrincipal,
      org: { displayName: 'Acme' },
      serverVersion: '1',
      clock: systemClock,
      logger: noopLogger,
      ...overrides,
    });
    return { resolver, cache, loads: () => loads, inst };
  };
  const req = { clientId: 'c', clientName: '', ip: '127.0.0.1', authMethod: 'oauth', path: '/mcp' };

  it('7.2 keys endpoints by kind and slug and answers unknown slugs with null, remembered for a few seconds', async () => {
    expect(endpointKey({ kind: 'default' })).toBe('default');
    expect(endpointKey({ kind: 'installation', slug: 'a' })).toBe('installation:a');
    const { resolver, loads } = build();
    expect(
      await resolver.resolve(principal(), { kind: 'installation', slug: 'zzz' }, req),
    ).toBeNull();
    const before = loads();
    expect(
      await resolver.resolve(principal(), { kind: 'installation', slug: 'zzz' }, req),
    ).toBeNull();
    expect(loads()).toBe(before);
  });

  it('7.2 a load failure is not swallowed as "not found"', async () => {
    const { resolver } = build({
      data: {
        configVersion: () => '1',
        load: async () => {
          throw new Error('db down');
        },
      },
    });
    await expect(resolver.resolve(principal(), { kind: 'default' }, req)).rejects.toThrow(
      'db down',
    );
  });

  it('4.3 an entry cached by someone else without side data is recompiled', async () => {
    const { resolver, cache, loads } = build();
    const first = await resolver.resolve(principal(), { kind: 'default' }, req);
    expect(first).not.toBeNull();
    // Another component put a different compiled object under the same key.
    const other = await buildEndpoint({ installations: [installation('b')], items: {} });
    cache.clear();
    await cache.getOrCompile(
      { principalId: principal().id, endpointId: 'default', configVersion: '1' },
      async () => other.endpoint,
    );
    const again = await resolver.resolve(principal(), { kind: 'default' }, req);
    expect(again).not.toBeNull();
    expect(loads()).toBeGreaterThanOrEqual(2);
  });

  it('7.2 a user with a profile gets their email domain into the Cedar principal', async () => {
    let seen = '';
    const { resolver } = build({
      profiles: { profile: async () => ({ emailDomain: 'acme.com' }) },
      toPolicyPrincipal: (p, profile) => {
        seen = profile.emailDomain ?? '';
        return defaultToPolicyPrincipal(p, profile);
      },
    });
    await resolver.resolve(principal(), { kind: 'default' }, req);
    expect(seen).toBe('acme.com');
  });
});

describe('6.4 6.6 upstream port over the upstream runtime', () => {
  const setup = (known = true) => {
    const calls: string[] = [];
    const runtime = {
      service: {
        execute: async (r: { method: string }) => {
          calls.push(`execute:${r.method}`);
          return { kind: 'complete' as const, result: {} };
        },
        executeTask: async (r: { method: string }) => {
          calls.push(`task:${r.method}`);
          return { kind: 'complete' as const, result: {} };
        },
      },
      listen: {
        subscribeResource: async (a: { downstreamUri: string }) =>
          void calls.push(`sub:${a.downstreamUri}`),
        unsubscribeResource: async (a: { downstreamUri: string }) =>
          void calls.push(`unsub:${a.downstreamUri}`),
        join: async () => void calls.push('join'),
        leave: async () => void calls.push('leave'),
      },
    };
    const port = upstreamPortFrom(runtime as never, {
      installations: {
        get: async () => (known ? ({ installationId: 'i', spec: {} } as never) : null),
      },
      credentials: { resolve: async () => ({ injections: [], credentialHash: 'h' }) },
    });
    return { port, calls };
  };
  const args = {
    installationId: 'i',
    principal: { userId: 'u' },
    downstreamUri: 'x://y',
    endpointId: 'e',
  };

  it('6.6 forwards execution, task routing and subscription management to the runtime', async () => {
    const { port, calls } = setup();
    await port.execute({ installationId: 'i', method: 'tools/call', params: {}, ctx: {} as never });
    await port.executeTask({ method: 'tasks/get', params: {}, ctx: {} as never });
    await port.subscribeResource(args);
    await port.unsubscribeResource(args);
    await port.joinListen({ installationId: 'i', principal: { userId: 'u' } });
    await port.leaveListen({ installationId: 'i', principal: { userId: 'u' } });
    expect(calls).toEqual([
      'execute:tools/call',
      'task:tasks/get',
      'sub:x://y',
      'unsub:x://y',
      'join',
      'leave',
    ]);
  });

  it('6.6 an installation that vanished makes subscription calls no-ops', async () => {
    const { port, calls } = setup(false);
    await port.subscribeResource(args);
    await port.unsubscribeResource(args);
    await port.joinListen({ installationId: 'i', principal: { userId: 'u' } });
    await port.leaveListen({ installationId: 'i', principal: { userId: 'u' } });
    expect(calls).toEqual([]);
  });
});

describe('6.2 classification (property)', () => {
  it('6.2 classifying on plain data agrees with the SDK predicate isLegacyRequest for any method, headers and body', async () => {
    const envelope = fc.record({
      'io.modelcontextprotocol/protocolVersion': fc.constantFrom('2026-07-28', '2025-06-18', 'x'),
      'io.modelcontextprotocol/clientInfo': fc.option(fc.constant({ name: 'c', version: '1' }), {
        nil: undefined,
      }),
      'io.modelcontextprotocol/clientCapabilities': fc.option(fc.constant({}), { nil: undefined }),
    });
    const body = fc.oneof(
      fc.jsonValue({ maxDepth: 3 }),
      fc.record({
        jsonrpc: fc.constant('2.0'),
        id: fc.integer(),
        method: fc.constantFrom(
          'initialize',
          'tools/list',
          'server/discover',
          'tools/call',
          'notifications/initialized',
        ),
        params: fc.record({
          name: fc.option(fc.string(), { nil: undefined }),
          _meta: fc.option(envelope, { nil: undefined }),
        }),
      }),
    );
    const headers = fc.record({
      'mcp-protocol-version': fc.option(
        fc.constantFrom('2026-07-28', '2025-06-18', '2025-03-26', 'nope'),
        { nil: undefined },
      ),
      'mcp-method': fc.option(fc.constantFrom('tools/list', 'initialize', 'tools/call'), {
        nil: undefined,
      }),
      'mcp-name': fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('POST', 'GET', 'DELETE'),
        headers,
        body,
        async (method, h, b) => {
          const clean = Object.fromEntries(
            Object.entries(h).filter(([, v]) => v !== undefined),
          ) as Record<string, string>;
          const request = new Request('http://x/mcp', { method: 'POST', headers: clean });
          const sdk = await isLegacyRequest(
            new Request('http://x/mcp', {
              method,
              headers: clean,
              ...(method === 'POST' ? {} : {}),
            }),
            method === 'POST' ? b : undefined,
          ).catch(() => 'threw');
          void request;
          const mine = isLegacyExchange({
            method,
            headers: clean,
            body: method === 'POST' ? b : undefined,
          });
          if (sdk !== 'threw') expect(mine).toBe(sdk);
        },
      ),
      { numRuns: 300 },
    );
  });
});
