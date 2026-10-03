import { BastionError, UpstreamUnavailableError } from '@bastion-mcp/core';
import type { UpstreamItems } from '@bastion-mcp/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyCallScope } from '../src/input-required/call-scope';
import {
  budgetedTimeout,
  inputRequiredPayload,
  remainingBudget,
} from '../src/input-required/helpers';
import { failureRecord, swallow } from '../src/instances/failure';
import {
  isSharedPackage,
  MAX_SHARED_REPLICAS,
  newInstanceRecord,
  pickSharedReplica,
} from '../src/instances/rows';
import { StartProgress } from '../src/instances/start';
import { LIST_ITEM_KEY, LIST_METHODS, minDefined } from '../src/lists/kinds';
import {
  applyPinVerdict,
  assembleItems,
  changedKinds,
  readAllPages,
  UpstreamLists,
} from '../src/lists/source';
import type { PinChecker } from '../src/ports';
import { UPSTREAM_TIMEOUTS_MS } from '../src/timeouts';
import { FakeRedis } from './helpers/fake-redis';
import { installationOf, packageSpec, remoteSpec } from './helpers/fixtures';
import { FakeCredentials, MemoryInstallations, MemorySnapshotStore } from './helpers/memory-ports';

describe('8.6 shared pool replica choice', () => {
  const rows = (...loads: number[]) => loads.map((load, i) => ({ row: `r${i}`, load }));

  it('8.6 an idle replica is reused, the least loaded first', () => {
    expect(pickSharedReplica(rows(3, 0, 2), 4)).toBe('r1');
  });

  it('8.6 when every replica is busy and the pool may grow, a new replica is asked for', () => {
    expect(pickSharedReplica(rows(2, 1), 3)).toBeUndefined();
    expect(pickSharedReplica([], 3)).toBeUndefined();
  });

  it('8.6 a full pool hands out the least loaded replica even when busy', () => {
    expect(pickSharedReplica(rows(2, 1), 2)).toBe('r1');
  });

  it('8.6 at least one replica, and never more than the cap whatever the catalog asks for', () => {
    expect(pickSharedReplica(rows(5), 0)).toBe('r0');
    expect(
      pickSharedReplica(rows(...Array.from({ length: MAX_SHARED_REPLICAS }, () => 1)), 99),
    ).toBe('r0');
    expect(
      pickSharedReplica(rows(...Array.from({ length: MAX_SHARED_REPLICAS - 1 }, () => 1)), 99),
    ).toBeUndefined();
  });

  it('8.6 new rows of shared pools belong to the catalog version, per-user rows to the installation', () => {
    const shared = installationOf(packageSpec({ instanceScope: 'shared' }));
    expect(isSharedPackage(shared)).toBe(true);
    expect(newInstanceRecord(shared, 'sandbox', 2, 1234)).toMatchObject({
      installationId: null,
      userId: null,
      catalogVersionId: 'ver-1',
      replica: 2,
      lastUsedAt: 1234,
      failures: [],
    });
    const own = installationOf(packageSpec({ instanceScope: 'perUser' }));
    expect(isSharedPackage(own)).toBe(false);
    expect(newInstanceRecord(own, 'sandbox', 0, 5)).toMatchObject({
      installationId: 'inst-1',
      userId: own.ownerUserId,
    });
    expect(isSharedPackage(installationOf(remoteSpec('https://upstream.example/mcp')))).toBe(false);
  });
});

describe('8.6 start failures', () => {
  const record = newInstanceRecord(installationOf(packageSpec()), 'sandbox', 0, 0);

  it('8.6 a failure is appended and the latest one kept with phase, message and stderr tail', () => {
    const { updated, message, markInstallation } = failureRecord(
      record,
      'installing',
      new Error('npm ERR'),
      ['line'],
      1000,
    );
    expect(message).toBe('npm ERR');
    expect(updated.failures).toHaveLength(1);
    expect(updated.error).toEqual({
      phase: 'installing',
      message: 'npm ERR',
      stderrTail: ['line'],
      at: 1000,
    });
    expect(typeof markInstallation).toBe('boolean');
  });

  it('8.6 non-Error failures are stringified', () => {
    expect(failureRecord(record, 'x', 'boom', [], 1).message).toBe('boom');
  });

  it('8.6 swallow hides a rejection and passes a value through', async () => {
    expect(await swallow(Promise.reject(new Error('x')))).toBeUndefined();
    expect(await swallow(Promise.resolve(3))).toBe(3);
  });

  it('8.6 progress follows the phases and a failure; setPhase leaves the machine alone', () => {
    const progress = new StartProgress();
    expect(progress.state.kind).toBe('starting');
    progress.enter('binding');
    expect(progress.phase).toBe('binding');
    progress.setPhase('connecting');
    expect(progress.phase).toBe('connecting');
    progress.apply({ type: 'fail' });
    expect(progress.state.kind).toBe('failed');
  });
});

describe('6.4 call budgets', () => {
  it('6.4 what is left of a deadline is never below 1 ms', () => {
    expect(remainingBudget(1500, 1000)).toBe(500);
    expect(remainingBudget(1000, 1000)).toBe(1);
    expect(remainingBudget(900, 1000)).toBe(1);
  });

  it('6.4 a call times out at its own limit or at the caller deadline, whichever is sooner', () => {
    expect(budgetedTimeout(60_000, undefined, 0)).toBe(60_000);
    expect(budgetedTimeout(60_000, 10_000, 0)).toBe(10_000);
    expect(budgetedTimeout(5_000, 10_000, 0)).toBe(5_000);
    expect(budgetedTimeout(5_000, 0, 10)).toBe(1);
  });

  it('6.5 the scope timer follows the injected clock: a pause keeps what was left', async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const scope = new LegacyCallScope({
        id: 'c',
        clientCapabilities: { elicitation: { form: {} } },
        roots: [],
        clock: { now: () => now },
      });
      scope.attach(new Promise(() => undefined));
      scope.armTimeout(10_000);
      now += 4_000;
      const ask = scope.handleServerRequest('elicitation', {});
      await vi.advanceTimersByTimeAsync(30);
      const event = await scope.next();
      expect(event.type).toBe('requests');
      // The timer is paused while the user is asked: nothing fires however long it takes.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scope.abort.signal.aborted).toBe(false);
      scope.resume({ b0: { action: 'accept' } });
      await ask;
      // 6 s of the 10 s were left when the timer paused.
      await vi.advanceTimersByTimeAsync(5_900);
      expect(scope.abort.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(scope.abort.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('13.x time limits are named, not scattered', () => {
    expect(UPSTREAM_TIMEOUTS_MS.remoteConnect).toBe(15_000);
    expect(UPSTREAM_TIMEOUTS_MS.sandboxConnect).toBe(30_000);
    expect(UPSTREAM_TIMEOUTS_MS.rpcDefaultCall).toBe(35 * 60_000);
  });
});

describe('6.5 input_required payload', () => {
  it('6.5 carries requestState always and inputRequests when there are some', () => {
    expect(inputRequiredPayload({ requestState: 's' })).toEqual({ requestState: 's' });
    const inputRequests = { b0: { method: 'roots/list', params: {} } };
    expect(inputRequiredPayload({ inputRequests, requestState: 's' })).toEqual({
      inputRequests,
      requestState: 's',
    });
  });
});

describe('7.5 list kinds and assembling', () => {
  it('7.5 one table names the four list methods and their result keys', () => {
    expect(LIST_METHODS).toEqual([
      'tools/list',
      'prompts/list',
      'resources/list',
      'resources/templates/list',
    ]);
    expect(LIST_ITEM_KEY['resources/templates/list']).toBe('resourceTemplates');
  });

  it('7.5 the shortest TTL wins and absent ones are ignored', () => {
    expect(minDefined([])).toBeUndefined();
    expect(minDefined([undefined, undefined])).toBeUndefined();
    expect(minDefined([5, undefined, 3, 9])).toBe(3);
  });

  it('7.5 four cached lists assemble into items with instructions, trimmed server info and the shortest TTL', () => {
    const items = assembleItems(
      [
        ['tools/list', { items: [{ name: 't' }], ttlMs: 500 }],
        ['prompts/list', { items: [{ name: 'p' }] }],
        ['resources/list', { items: [{ uri: 'u' }], ttlMs: 200 }],
        ['resources/templates/list', { items: [] }],
      ],
      'be nice',
      { name: 'fake', version: '1' },
    );
    expect(items.tools).toEqual([{ name: 't' }]);
    expect(items.prompts).toEqual([{ name: 'p' }]);
    expect(items.resources).toEqual([{ uri: 'u' }]);
    expect(items.resourceTemplates).toEqual([]);
    expect(items.instructions).toBe('be nice');
    expect(items.serverInfo).toEqual({ name: 'fake', version: '1' });
    expect(items.ttlMs).toBe(200);
    expect(assembleItems([], undefined, undefined).serverInfo).toBeUndefined();
  });

  it('7.5 a snapshot diff maps to list_changed kinds; templates count as resources', () => {
    const none = { tool: false, prompt: false, resource: false, resourceTemplate: false };
    expect(changedKinds(none)).toEqual([]);
    expect(changedKinds({ ...none, tool: true, prompt: true })).toEqual(['tools', 'prompts']);
    expect(changedKinds({ ...none, resourceTemplate: true })).toEqual(['resources']);
    expect(
      changedKinds({ tool: true, prompt: true, resource: true, resourceTemplate: true }),
    ).toEqual(['tools', 'prompts', 'resources']);
  });

  it('7.5 reading pages stops at the item cap and says so, keeping the shortest ttl', async () => {
    const pages: Record<string, { tools: number[]; nextCursor?: string; ttlMs?: number }> = {
      first: { tools: [1, 2, 3], nextCursor: 'second', ttlMs: 900 },
      second: { tools: [4, 5, 6], nextCursor: 'third', ttlMs: 300 },
    };
    const out = await readAllPages(async (cursor) => pages[cursor ?? 'first'] ?? {}, 'tools', 4);
    expect(out.items).toEqual([1, 2, 3, 4]);
    expect(out.truncated).toBe(true);
  });

  it('7.5 a list that ends exactly at the cap is not truncated', async () => {
    const out = await readAllPages(async () => ({ tools: [1, 2], ttlMs: 7 }), 'tools', 2);
    expect(out).toEqual({ items: [1, 2], truncated: false, ttlMs: 7 });
  });
});

describe('13.6 pin verdicts', () => {
  const items = (): UpstreamItems => ({
    tools: [{ name: 'a' }, { name: 'b' }] as UpstreamItems['tools'],
    prompts: [],
    resources: [],
    resourceTemplates: [],
  });

  it('13.6 no drift leaves the list alone', () => {
    const list = items();
    expect(applyPinVerdict(list, { ok: true })).toEqual({ items: list });
  });

  it('13.6 hideChanged drops the drifted tools only', () => {
    const out = applyPinVerdict(items(), { ok: false, action: 'hideChanged', changed: ['b'] });
    expect(out.items.tools).toEqual([{ name: 'a' }]);
    expect(out.drifted).toBeUndefined();
  });

  it('13.6 warn keeps every tool and reports the drift', () => {
    const out = applyPinVerdict(items(), { ok: false, action: 'warn', changed: ['a'] });
    expect(out.items.tools).toHaveLength(2);
    expect(out.drifted).toEqual(['a']);
  });

  it('13.6 block fails the listing', () => {
    expect(() => applyPinVerdict(items(), { ok: false, action: 'block', changed: ['a'] })).toThrow(
      BastionError,
    );
  });
});

describe('7.5 listing an installation', () => {
  const info = { id: 'inst-1' } as never;
  const ctx = { principalId: 'user-1' } as never;
  const toolsResult = { tools: [{ name: 'a' }, { name: 'b' }] };

  const build = (
    options: {
      spec?: ReturnType<typeof packageSpec>;
      execute?: (method: string) => Promise<unknown>;
      pins?: PinChecker;
      startWaitMs?: number;
    } = {},
  ) => {
    const installations = new MemoryInstallations();
    installations.add(installationOf(options.spec ?? remoteSpec('https://upstream.example/mcp')));
    const changed: unknown[] = [];
    const executed: string[] = [];
    const lists = new UpstreamLists({
      service: {
        onSession: () => undefined,
        execute: async (request: { method: string }) => {
          executed.push(request.method);
          const result = options.execute
            ? await options.execute(request.method)
            : request.method === 'tools/list'
              ? toolsResult
              : {};
          return { kind: 'complete', result };
        },
        upstreamMeta: () => ({ instructions: 'hi' }),
        locateInstance: async () => ({ instanceId: 'i', owner: 'none' }),
      } as never,
      redis: new FakeRedis(),
      installations,
      credentials: new FakeCredentials(),
      snapshots: new MemorySnapshotStore(),
      changed: { listChanged: (...args: unknown[]) => void changed.push(args) },
      ...(options.pins ? { pins: options.pins } : {}),
      ...(options.startWaitMs === undefined ? {} : { startWaitMs: options.startWaitMs }),
    });
    return { lists, changed, executed };
  };

  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('7.5 a live list reads all four kinds and applies hideChanged pins to every origin', async () => {
    const { lists, executed } = build({
      pins: { check: async () => ({ ok: false, action: 'hideChanged', changed: ['b'] }) },
    });
    const result = await lists.listItems(info, ctx);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(executed.sort()).toEqual([
      'prompts/list',
      'resources/list',
      'resources/templates/list',
      'tools/list',
    ]);
    expect(result.items.tools).toEqual([{ name: 'a' }]);
    expect(result.items.instructions).toBe('hi');
    // The second call is served from the cache and still hides the drifted tool.
    const again = await lists.listItems(info, ctx);
    expect(again.status === 'ok' && again.origin).toBe('cache');
    expect(again.status === 'ok' && again.items.tools).toEqual([{ name: 'a' }]);
  });

  it('13.6 a blocking pin degrades the installation with the stable code', async () => {
    const { lists } = build({
      pins: { check: async () => ({ ok: false, action: 'block', changed: ['a'] }) },
    });
    const result = await lists.listItems(info, ctx);
    expect(result).toMatchObject({ status: 'degraded', code: 'pin_drift_blocked' });
  });

  it('7.5 a server that does not know tools/list is reported as not being an MCP endpoint', async () => {
    const { lists } = build({
      execute: async (method) => {
        if (method === 'tools/list') {
          throw new BastionError('UPSTREAM_RPC', 'Method not found', {
            httpStatus: 502,
            mcpCode: -32601,
          });
        }
        return {};
      },
    });
    const result = await lists.listItems(info, ctx);
    expect(result.status).toBe('degraded');
    expect(result).toMatchObject({ detail: expect.stringContaining('MCP endpoint') });
  });

  it('7.5 a first list of a stopped sandbox with no snapshot waits for the start, then reports it started', async () => {
    const { lists } = build({ spec: packageSpec() as never, startWaitMs: 500 });
    const result = await lists.listItems(info, ctx);
    expect(result.status === 'ok' && result.origin).toBe('started');
  });

  it('7.5 a start that outlasts the wait degrades with "starting" and announces list_changed when it finishes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { lists, changed } = build({
      spec: packageSpec() as never,
      startWaitMs: 20,
      execute: async (method) => {
        await gate;
        return method === 'tools/list' ? toolsResult : {};
      },
    });
    const result = await lists.listItems(info, ctx);
    expect(result).toEqual({ status: 'degraded', code: 'starting' });
    expect(changed).toHaveLength(0);
    release?.();
    await vi.waitFor(() => expect(changed).toHaveLength(1));
    expect((changed[0] as unknown[])[1]).toEqual(['tools', 'prompts', 'resources']);
  });

  it('7.5 a failing tools/list is not swallowed as an empty list', async () => {
    const { lists } = build({
      execute: async () => {
        throw new UpstreamUnavailableError('down', { installation: 'fake' });
      },
    });
    const result = await lists.listItems(info, ctx);
    expect(result).toMatchObject({ status: 'degraded', code: 'upstream_unavailable' });
  });
});
