import type {
  InstanceState,
  SandboxDriver,
  SandboxHandle,
  StderrLogger,
  StderrPipeline,
  StderrSink,
} from '@bastion-mcp/sandbox';
import type { BastionMetrics } from '@bastion-mcp/telemetry';
import type { UpstreamConnector, UpstreamSession } from '../connectors/types';
import type { ContinuationRegistry } from '../input-required/registry';
import type { LeaseManager } from '../ownership/lease';
import type { WorkerRegistry } from '../ownership/registry';
import type {
  CallPrincipal,
  Clock,
  EgressPolicyWriter,
  InstallationStatusSink,
  InstanceRecord,
  InstanceRepository,
  Logger,
  RedisLike,
  ResolvedCredential,
  ResolvedInstallation,
  RunnerTokenStore,
} from '../ports';
import type { InstanceTelemetry } from './telemetry';

export type LiveInstance = {
  id: string;
  record: InstanceRecord;
  installation: ResolvedInstallation;
  session: UpstreamSession;
  continuations: ContinuationRegistry;
  handle?: SandboxHandle | undefined;
  stderr?: StderrPipeline | undefined;
  state: InstanceState;
  startedAt: number;
  /** Catalog version the process runs (version change, 8.6). */
  versionId: string;
  /** The credential and principal this connection was opened for (list cache keys, notifications, 6.6). */
  credentialHash: string;
  principalId: string;
  inflight: number;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  stopping: boolean;
  drainWaiters: (() => void)[];
  lastPersistedAt: number;
};

export type EnsureArgs = {
  record: InstanceRecord;
  installation: ResolvedInstallation;
  principal: CallPrincipal;
  credential: ResolvedCredential;
  signal: AbortSignal;
};

export type EnsureResult =
  | { kind: 'local'; live: LiveInstance }
  | { kind: 'forward'; workerId: string; address: string };

export type InstanceManagerDeps = {
  redis: RedisLike;
  repo: InstanceRepository;
  tokens: RunnerTokenStore;
  driver: SandboxDriver;
  egress: EgressPolicyWriter;
  status: InstallationStatusSink;
  leases: LeaseManager;
  registry: WorkerRegistry;
  connectors: { http: UpstreamConnector; sse: UpstreamConnector; sandbox: UpstreamConnector };
  /** `BASTION_MAX_RUNNING_INSTANCES_PER_USER` (default 10) and `BASTION_MAX_RUNNING_SANDBOXES` (default 500). */
  limits: { maxRunningPerUser: number; maxRunningTotal: number };
  /** `<worker Service ClusterIP>:3128` or the per-instance unix socket address the runner proxies through (8.8). */
  egressAddress: string;
  npmRegistry?: string | undefined;
  pypiIndexUrl?: string | undefined;
  telemetry?: InstanceTelemetry;
  metrics?:
    | Pick<BastionMetrics, 'sandboxStarts' | 'sandboxStartDuration' | 'instancesActive'>
    | undefined;
  stderrSink?: StderrSink | undefined;
  stderrLogger?: StderrLogger | undefined;
  clock?: Clock;
  logger?: Logger;
  /** How often idle instances are looked for. */
  idleSweepMs?: number;
  /** Persist `lastUsedAt` at most this often. */
  touchPersistMs?: number;
};
