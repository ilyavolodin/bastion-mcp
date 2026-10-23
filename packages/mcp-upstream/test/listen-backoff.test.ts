import { describe, expect, it } from 'vitest';
import {
  LISTEN_RETRY_MAX_MS,
  LISTEN_UNSUPPORTED_RETRY_MS,
  ListenManager,
} from '../src/listen/manager';
import type { Logger, ResolvedCredential } from '../src/ports';
import { FakeRedis } from './helpers/fake-redis';
import { installationOf, principal, remoteSpec } from './helpers/fixtures';

const credential: ResolvedCredential = { injections: [], credentialHash: 'cred-1' };

/** A manager whose upstream session refuses `listen` with `failWith`; `attempts()` counts the tries. */
const setup = (failWith: Error) => {
  let now = 1_000_000;
  let attempts = 0;
  const logs: { level: string; message: string }[] = [];
  const logger: Logger = {
    debug() {},
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error() {},
  };
  const manager = new ListenManager({
    service: {
      onSession() {},
      pooledSession: async () => ({
        listen: async () => {
          attempts += 1;
          throw failWith;
        },
      }),
    } as never,
    lists: {} as never,
    publisher: {} as never,
    redis: new FakeRedis(),
    registry: { workerId: 'w1', lookup: async () => null } as never,
    rpc: {} as never,
    installations: {} as never,
    credentials: {} as never,
    clock: { now: () => now } as never,
    logger,
    tickMs: 5_000,
  });
  const args = {
    installation: installationOf(remoteSpec('http://127.0.0.1:1/mcp'), {
      installationId: 'inst-1',
    }),
    principal,
    credential,
  };
  return {
    manager,
    args,
    logs,
    attempts: () => attempts,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('6.6 a listen the upstream refuses is not retried every tick', () => {
  it('6.6 "method not found" is not asked again for 30 minutes, then once more', async () => {
    const x = setup(
      new Error(
        'Error POSTing to endpoint: {"error":{"code":-32601,"message":"method not found"}}',
      ),
    );
    await x.manager.join(x.args);
    expect(x.attempts()).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      x.advance(5_000);
      await x.manager.tick();
    }
    expect(x.attempts()).toBe(1);
    expect(x.logs.filter((l) => l.level === 'warn')).toEqual([]);
    x.advance(LISTEN_UNSUPPORTED_RETRY_MS);
    await x.manager.tick();
    expect(x.attempts()).toBe(2);
    await x.manager.close();
  });

  it('6.6 any other failure backs off with a doubling delay, capped', async () => {
    const x = setup(new Error('socket hang up'));
    await x.manager.join(x.args);
    expect(x.attempts()).toBe(1); // next try after 10 s
    x.advance(9_000);
    await x.manager.tick();
    expect(x.attempts()).toBe(1);
    x.advance(1_001);
    await x.manager.tick();
    expect(x.attempts()).toBe(2); // next try after 20 s
    x.advance(19_000);
    await x.manager.tick();
    expect(x.attempts()).toBe(2);
    x.advance(LISTEN_RETRY_MAX_MS);
    await x.manager.tick();
    expect(x.attempts()).toBe(3);
    await x.manager.close();
  });
});
