import type { Keyring } from '@bastion-mcp/core';
import type { StderrSink } from '@bastion-mcp/sandbox';
import { freePort } from '@bastion-mcp/testkit';
import type { ListChangedPublisher, RedisLike } from '../../src/ports';
import {
  createUpstreamRuntime,
  type UpstreamRuntime,
  type UpstreamRuntimeOptions,
} from '../../src/runtime';
import { LOOPBACK_SETTINGS } from './fixtures';
import type { Shared } from './harness';
import {
  connectUrls,
  FakeCredentials,
  MemoryInstallations,
  MemorySnapshotStore,
} from './memory-ports';

export const keyring: Keyring = { activeKid: 'k1', keys: new Map([['k1', Buffer.alloc(32, 9)]]) };
export const SECRET = 's'.repeat(40);

export { freePort };

export type TestWorld = {
  shared: Shared;
  installations: MemoryInstallations;
  credentials: FakeCredentials;
  snapshots: MemorySnapshotStore;
  changed: {
    calls: { installationId: string; kinds: string[] }[];
    publisher: ListChangedPublisher;
  };
};

export const newWorld = (shared: Shared): TestWorld => {
  const calls: { installationId: string; kinds: string[] }[] = [];
  return {
    shared,
    installations: new MemoryInstallations(),
    credentials: new FakeCredentials(),
    snapshots: new MemorySnapshotStore(),
    changed: {
      calls,
      publisher: {
        listChanged: (installation, kinds) => {
          calls.push({ installationId: installation.installationId, kinds });
        },
      },
    },
  };
};

export type TestWorker = {
  runtime: UpstreamRuntime;
  workerId: string;
  port: number;
  stopRpc: () => Promise<void>;
  /** Simulates a crash: the RPC server stops and nothing is cleaned up. */
  crash: () => Promise<void>;
};

export const startWorker = async (
  world: TestWorld,
  workerId: string,
  overrides: Partial<UpstreamRuntimeOptions> & { stderrSink?: StderrSink } = {},
): Promise<TestWorker> => {
  const port = await freePort();
  const runtime = createUpstreamRuntime({
    redis: world.shared.redis as RedisLike,
    workerId,
    address: `127.0.0.1:${port}`,
    role: 'worker',
    version: '9.9.9',
    internalSecret: SECRET,
    stateKeyring: keyring,
    repo: world.shared.repo,
    tokens: world.shared.tokens,
    driver: world.shared.driver,
    status: world.shared.status,
    installations: world.installations,
    credentials: world.credentials,
    connectUrls,
    snapshots: world.snapshots,
    remote: { ...LOOPBACK_SETTINGS },
    limits: { maxRunningPerUser: 10, maxRunningTotal: 500 },
    egressAddress: '10.1.2.3:3128',
    ...overrides,
  });
  await runtime.start();
  const listener = await runtime.rpcServer.listen(port, '127.0.0.1');
  return {
    runtime,
    workerId,
    port,
    stopRpc: () => listener.close(),
    crash: async () => {
      await listener.close();
      await runtime.listen.close();
      await runtime.pool.closeAll();
      await runtime.instances.closeConnections();
      // The heartbeat timer stops with the process: simulate by removing the registry entry and the timer.
      await runtime.registry.stop();
    },
  };
};
