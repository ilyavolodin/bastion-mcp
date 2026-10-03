import type { ServerSpec } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import type { UpstreamAccess } from '../src/adapters/upstream-access';
import { runServer } from '../src/adapters/version-test-server';
import type { StepOutcome, StepRunner, TestEnv } from '../src/adapters/version-test-types';
import { MAX_STEP_DETAIL_CHARS, VERSION_TEST_LIST_TIMEOUT_MS } from '../src/timing';
import { fakeInfra } from './fake-infra';

type ListFresh = UpstreamAccess['listFresh'];

const remoteSpec = { type: 'remote', url: 'https://example.test/mcp' } as unknown as ServerSpec;

const setup = (listFresh: ListFresh, instanceRecord: object | null = null) => {
  const restarts: string[] = [];
  const timeouts: (number | undefined)[] = [];
  const outcomes: { id: string; outcome: StepOutcome }[] = [];
  const env: TestEnv = {
    infra: fakeInfra({
      config: { publicUrl: 'https://bastion.test' },
      db: { prisma: { definitionPin: { deleteMany: async () => ({ count: 0 }) } } },
      redis: {
        xrevrange: async () => {
          throw new Error('no redis in this test');
        },
      },
      repos: {
        installations: {
          getByOwnerSlug: async () => ({ id: 'inst-1' }),
        },
        instances: { getForInstallation: async () => instanceRecord },
      },
    }),
    deps: {
      access: {
        restart: async (id: string) => void restarts.push(id),
        listFresh: (async (...args: Parameters<ListFresh>) => {
          timeouts.push(args[2]?.timeoutMs);
          return listFresh(...args);
        }) as ListFresh,
      } as unknown as UpstreamAccess,
      guards: {} as never,
      events: {} as never,
    },
  };
  const step: StepRunner = async (id, fn) => {
    const outcome = await fn();
    outcomes.push({ id, outcome });
    return outcome.status !== 'failed';
  };
  const run = () =>
    runServer(
      env,
      {
        entry: { id: 'e', slug: 'demo', kind: 'mcp_server', displayName: 'Demo' },
        versionId: '99999999-9999-4999-8999-999999999999',
        authorId: 'author',
        spec: remoteSpec,
        form: {},
        draft: true,
      },
      step,
    );
  return { run, restarts, timeouts, outcomes };
};

describe('11.3 TEST flow, connect step', () => {
  it('stops after a failed connect and describes the failure with the instance error and stderr', async () => {
    const h = setup(
      async () => ({ status: 'degraded', code: 'spawn_failed', detail: 'exit 127' }),
      {
        id: 'inst',
        error: { phase: 'install', message: 'npm exploded', stderrTail: ['E404 not found'] },
      },
    );
    await h.run();
    expect(h.outcomes.map((o) => o.id)).toEqual(['prepare', 'lockfile', 'connect']);
    const connect = h.outcomes[2]?.outcome;
    expect(connect?.status).toBe('failed');
    expect(connect?.detail).toBe(
      [
        'could not list the server (spawn_failed)',
        'exit 127',
        'failed in phase "install": npm exploded',
        'stderr:',
        'E404 not found',
      ].join('\n'),
    );
  });

  it('asks for the long cold-start wait and restarts the instance first', async () => {
    const h = setup(async () => ({ status: 'degraded', code: 'x' }));
    await h.run();
    expect(h.timeouts).toEqual([VERSION_TEST_LIST_TIMEOUT_MS]);
    expect(h.restarts).toEqual(['inst-1']);
  });

  it('turns a missing sign-in into a connect link instead of a server fault', async () => {
    const h = setup(async () => ({ status: 'degraded', code: 'upstream_auth_required' }));
    await h.run();
    const connect = h.outcomes.at(-1)?.outcome;
    expect(connect?.status).toBe('failed');
    expect(connect?.connectUrl).toBe('https://bastion.test/connect/inst-1');
  });

  it('caps the failure detail', async () => {
    const h = setup(async () => ({
      status: 'degraded',
      code: 'x',
      detail: 'y'.repeat(MAX_STEP_DETAIL_CHARS * 2),
    }));
    await h.run();
    expect(h.outcomes.at(-1)?.outcome.detail).toHaveLength(MAX_STEP_DETAIL_CHARS);
  });
});
