import type { GcKnownState, SandboxDriver } from '@bastion-mcp/sandbox';
import { describe, expect, it } from 'vitest';
import {
  cleanupExpired,
  pinReverification,
  upstreamTokenSweep,
} from '../src/scheduler/tasks/maintenance';
import { mirrorPush } from '../src/scheduler/tasks/mirror-push';
import {
  registryFullResync,
  registrySyncDue,
  registrySyncOne,
} from '../src/scheduler/tasks/registry-sync';
import { knownSandboxState, sandboxGarbageCollection } from '../src/scheduler/tasks/sandbox-gc';
import type { SchedulerDeps, TaskContext } from '../src/scheduler/types';
import { fakeInfra, recordingLogger } from './fake-infra';

const NOW = new Date('2026-03-01T12:00:00Z');

const ctxOf = (infraParts: object, deps: SchedulerDeps = {}): TaskContext => {
  const logger = recordingLogger();
  return {
    infra: fakeInfra({ logger, ...infraParts }),
    deps,
    now: () => NOW,
    enqueue: async () => undefined,
  };
};

const loggerOf = (ctx: TaskContext) =>
  ctx.infra.logger as unknown as ReturnType<typeof recordingLogger>;

describe('9.6 upstreamTokenSweep', () => {
  it('skips without a refresh callback', async () => {
    expect(await upstreamTokenSweep(ctxOf({}), undefined as never)).toEqual({
      skipped: 'no refresh callback',
    });
  });

  it('looks 26 hours ahead, counts successes and failures and never throws', async () => {
    let asked: Date | undefined;
    const refreshed: string[] = [];
    const ctx = ctxOf(
      {
        repos: {
          upstreamTokens: {
            listExpiringBefore: async (before: Date) => {
              asked = before;
              return [
                { principalId: 'p1', installationId: 'i1' },
                { principalId: 'p2', installationId: 'i2' },
              ];
            },
          },
        },
      },
      {
        refreshUpstreamToken: async (principalId, installationId) => {
          if (principalId === 'p2') throw new Error('revoked');
          refreshed.push(`${principalId}/${installationId}`);
        },
      },
    );
    const result = await upstreamTokenSweep(ctx, undefined as never);
    expect(asked?.toISOString()).toBe('2026-03-02T14:00:00.000Z');
    expect(refreshed).toEqual(['p1/i1']);
    expect(result).toEqual({ candidates: 2, refreshed: 1, failed: 1 });
    expect(loggerOf(ctx).calls.warn[0]?.message).toBe('upstream token refresh failed');
  });
});

describe('13.6 pinReverification', () => {
  it('skips without a callback', async () => {
    expect(await pinReverification(ctxOf({}), undefined as never)).toEqual({
      skipped: 'no reverify callback',
    });
  });

  it('re-verifies every pinned installation and counts failures', async () => {
    const seen: string[] = [];
    const ctx = ctxOf(
      { db: { prisma: { $queryRaw: async () => [{ id: 'a' }, { id: 'b' }] } } },
      {
        reverifyPins: async (id) => {
          seen.push(id);
          if (id === 'b') throw new Error('upstream down');
        },
      },
    );
    expect(await pinReverification(ctx, undefined as never)).toEqual({
      installations: 2,
      failed: 1,
    });
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('9.3 cleanupExpired', () => {
  it('purges oidc models expired at the task clock', async () => {
    let at: Date | undefined;
    const ctx = ctxOf({
      repos: {
        oidcModels: {
          purgeExpired: async (d: Date) => {
            at = d;
            return 4;
          },
        },
      },
    });
    expect(await cleanupExpired(ctx, undefined as never)).toEqual({ oidcModels: 4 });
    expect(at).toEqual(NOW);
  });
});

describe('25.5 mirrorPush', () => {
  const marketplaces = [
    { id: 'm1', mirror: { url: 'x' } },
    { id: 'm2', mirror: null },
    { id: 'm3', mirror: { url: 'y' } },
  ];
  const infra = { db: { prisma: { marketplace: { findMany: async () => marketplaces } } } };

  it('skips without a callback', async () => {
    expect(await mirrorPush(ctxOf(infra), undefined)).toEqual({ skipped: 'no mirror callback' });
  });

  it('pushes the marketplace of the payload only', async () => {
    const pushed: string[] = [];
    const ctx = ctxOf(infra, { pushMirror: async (id) => void pushed.push(id) });
    expect(await mirrorPush(ctx, { marketplaceId: 'm2' })).toEqual({ marketplaces: 1, failed: 0 });
    expect(pushed).toEqual(['m2']);
  });

  it('without a payload pushes every marketplace with a mirror and survives failures', async () => {
    const pushed: string[] = [];
    const ctx = ctxOf(infra, {
      pushMirror: async (id) => {
        pushed.push(id);
        if (id === 'm1') throw new Error('diverged');
      },
    });
    expect(await mirrorPush(ctx, undefined)).toEqual({ marketplaces: 2, failed: 1 });
    expect(pushed).toEqual(['m1', 'm3']);
    expect(loggerOf(ctx).calls.warn[0]?.message).toBe('mirror push failed');
  });
});

describe('11.6 registry sync tasks', () => {
  const sourcesRepo = (sources: object[]) => ({
    repos: {
      registrySources: {
        list: async () => sources,
        get: async (id: string) => sources.find((s) => (s as { id: string }).id === id) ?? null,
      },
    },
  });

  it('registrySyncOne reports nothing synced for an unknown source', async () => {
    expect(await registrySyncOne(ctxOf(sourcesRepo([])), { sourceId: 'nope' })).toEqual({
      synced: [],
    });
  });

  it('registryFullResync skips disabled sources and registrySyncDue skips sources not yet due', async () => {
    const disabled = { id: 's1', enabled: false };
    expect(await registryFullResync(ctxOf(sourcesRepo([disabled])), undefined as never)).toEqual({
      synced: [],
    });
    const notDue = {
      id: 's2',
      enabled: true,
      syncIntervalS: 3600,
      lastSync: { finishedAt: new Date(NOW.getTime() - 1_000).toISOString() },
    };
    expect(await registrySyncDue(ctxOf(sourcesRepo([notDue])), undefined as never)).toEqual({
      synced: [],
    });
  });
});

describe('8.4 sandbox garbage collection', () => {
  const driverWith = (extra: object): SandboxDriver => extra as SandboxDriver;

  it('skips without a driver', async () => {
    expect(await sandboxGarbageCollection(ctxOf({}), undefined as never)).toEqual({
      skipped: 'no driver',
    });
  });

  it('lets a collecting driver decide from what Postgres and Redis know', async () => {
    let known: GcKnownState | undefined;
    const driver = driverWith({
      collectGarbage: async (state: GcKnownState) => {
        known = state;
        return [
          { name: 'claim-a', delete: true },
          { name: 'claim-b', delete: false },
        ];
      },
    });
    const ctx = ctxOf(
      {
        db: {
          prisma: {
            instance: {
              findMany: async () => [
                {
                  id: 'live',
                  lastUsedAt: new Date(NOW.getTime() - 5_000),
                  updatedAt: null,
                  createdAt: NOW,
                },
                {
                  id: 'idle',
                  lastUsedAt: null,
                  updatedAt: new Date(NOW.getTime() - 60_000),
                  createdAt: NOW,
                },
              ],
            },
            installation: { findMany: async () => [{ id: 'inst-1' }] },
          },
        },
        redis: { exists: async (key: string) => (key.endsWith('live') ? 1 : 0) },
      },
      { driver },
    );
    expect(await sandboxGarbageCollection(ctx, undefined as never)).toEqual({
      driver: 'kubernetes',
      deleted: ['claim-a'],
    });
    expect(known?.instances.get('live')).toEqual({ leaseExpiredAt: null });
    expect(known?.instances.get('idle')).toEqual({ leaseExpiredAt: NOW.getTime() - 60_000 });
    expect([...(known?.installations ?? [])]).toEqual(['inst-1']);
  });

  it('never reports a lease expiry in the future', async () => {
    const ctx = ctxOf({
      db: {
        prisma: {
          instance: {
            findMany: async () => [
              {
                id: 'x',
                lastUsedAt: new Date(NOW.getTime() + 99_000),
                updatedAt: null,
                createdAt: NOW,
              },
            ],
          },
          installation: { findMany: async () => [] },
        },
      },
      redis: { exists: async () => 0 },
    });
    const state = await knownSandboxState(ctx.infra, NOW);
    expect(state.instances.get('x')).toEqual({ leaseExpiredAt: NOW.getTime() });
  });

  it('sweeps a driver without collectGarbage through list(): unreferenced sandboxes are destroyed', async () => {
    const destroyed: string[] = [];
    const driver = driverWith({
      async *list() {
        yield { id: 'keep' };
        yield { id: 'orphan' };
      },
      destroy: async (ref: { id: string }) => void destroyed.push(ref.id),
    });
    const ctx = ctxOf(
      {
        db: {
          prisma: {
            instance: {
              findMany: async () => [{ sandboxRef: { id: 'keep' } }, { sandboxRef: null }],
            },
          },
        },
      },
      { driver },
    );
    expect(await sandboxGarbageCollection(ctx, undefined as never)).toEqual({
      driver: 'list',
      deleted: ['orphan'],
    });
    expect(destroyed).toEqual(['orphan']);
  });
});
