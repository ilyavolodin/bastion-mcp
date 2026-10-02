import { RemoteAgentRegistry } from '../../src/connectors/agent';
import { HttpConnector } from '../../src/connectors/http';
import { SandboxConnector } from '../../src/connectors/sandbox';
import { SseConnector } from '../../src/connectors/sse';
import type { UpstreamSession } from '../../src/connectors/types';
import { RedisEgressPolicyStore } from '../../src/instances/egress-store';
import {
  type EnsureArgs,
  InstanceManager,
  type InstanceManagerDeps,
} from '../../src/instances/manager';
import type { AcquireEvents, InstanceTelemetry } from '../../src/instances/telemetry';
import { LeaseManager } from '../../src/ownership/lease';
import { WorkerRegistry } from '../../src/ownership/registry';
import type { RedisLike, ResolvedInstallation } from '../../src/ports';
import { FakeRedis } from './fake-redis';
import { FakeSandboxDriver } from './fake-sandbox';
import { credential, ctxOf, LOOPBACK_SETTINGS, principal } from './fixtures';
import {
  FakeCredentials,
  MemoryInstanceRepository,
  MemoryStatusSink,
  MemoryTokenStore,
} from './memory-ports';

export type Shared = {
  redis: RedisLike;
  repo: MemoryInstanceRepository;
  tokens: MemoryTokenStore;
  driver: FakeSandboxDriver;
  status: MemoryStatusSink;
};

export const newShared = (redis: RedisLike = new FakeRedis()): Shared => ({
  redis,
  repo: new MemoryInstanceRepository(),
  tokens: new MemoryTokenStore(),
  driver: new FakeSandboxDriver(),
  status: new MemoryStatusSink(),
});

export class RecordingTelemetry implements InstanceTelemetry {
  readonly runs: string[][] = [];
  async acquire<T>(
    _attributes: Record<string, string | number | boolean>,
    fn: (events: AcquireEvents) => Promise<T>,
  ) {
    const events: string[] = [];
    this.runs.push(events);
    return fn({ add: (name) => void events.push(name) });
  }
}

export const makeWorker = (
  shared: Shared,
  workerId: string,
  overrides: Partial<InstanceManagerDeps> = {},
) => {
  const registry = new WorkerRegistry({
    redis: shared.redis,
    workerId,
    address: `127.0.0.1:${9000 + workerId.length}`,
    role: 'worker',
    version: '1.0.0',
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  const leases = new LeaseManager({
    redis: shared.redis,
    registry,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  const agents = new RemoteAgentRegistry();
  const connectorOptions = { agents, settings: LOOPBACK_SETTINGS, version: '1.0.0' };
  const telemetry = new RecordingTelemetry();
  const egress = new RedisEgressPolicyStore(shared.redis);
  const manager = new InstanceManager({
    redis: shared.redis,
    repo: shared.repo,
    tokens: shared.tokens,
    driver: shared.driver,
    egress,
    status: shared.status,
    leases,
    registry,
    connectors: {
      http: new HttpConnector(connectorOptions),
      sse: new SseConnector(connectorOptions),
      sandbox: new SandboxConnector({ version: '1.0.0' }),
    },
    limits: { maxRunningPerUser: 10, maxRunningTotal: 500 },
    egressAddress: '10.1.2.3:3128',
    npmRegistry: 'https://registry.example/npm',
    pypiIndexUrl: 'https://pypi.example/simple',
    telemetry,
    ...overrides,
  });
  return { registry, leases, manager, telemetry, egress, agents };
};

export const ensureArgs = async (
  manager: InstanceManager,
  installation: ResolvedInstallation,
  signal: AbortSignal = new AbortController().signal,
): Promise<EnsureArgs> => ({
  record: await manager.instanceFor(installation),
  installation,
  principal,
  credential,
  signal,
});

/** Runs a `whoami`/`echo` style call on a live instance. */
export const callOn = (
  manager: InstanceManager,
  live: Parameters<InstanceManager['run']>[0],
  name: string,
  args: Record<string, unknown> = {},
) =>
  manager.run(live, (session: UpstreamSession) =>
    session.callTool({ name, arguments: args }, { ctx: ctxOf({ era: 'legacy' }) }),
  );

export { FakeCredentials };
