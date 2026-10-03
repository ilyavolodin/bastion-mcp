import { randomBytes } from 'node:crypto';
import {
  MS,
  type PackageSpec,
  RateLimitedError,
  redisKeys,
  SandboxStartFailedError,
  sha256Hex,
  TTL,
} from '@bastion-mcp/core';
import { planSandboxStart, type SandboxInstanceInfo } from '@bastion-mcp/limits';
import {
  buildProxyUrl,
  CLOSE_CODE_REPLACED,
  crashCountsAsFailure,
  type InstanceStartPhase,
  instanceStateMachine,
  retryDecision,
  type SandboxHandle,
  type SandboxSpec,
  StderrPipeline,
  startAndWait,
} from '@bastion-mcp/sandbox';
import type { CloseInfo, UpstreamSession } from '../connectors/types';
import { ContinuationRegistry } from '../input-required/registry';
import {
  type Clock,
  type InstanceRecord,
  type Logger,
  noopLogger,
  type ResolvedInstallation,
  systemClock,
} from '../ports';
import { failureRecord, swallow } from './failure';
import { InflightCounter } from './inflight';
import { captureLockfileIn } from './lockfile';
import { isSharedPackage, newInstanceRecord, pickSharedReplica } from './rows';
import { StartProgress } from './start';
import { buildStartRequest } from './start-request';
import {
  type AcquireEvents,
  type InstanceTelemetry,
  noopInstanceTelemetry,
  SPAN_ATTRS,
} from './telemetry';
import type { EnsureArgs, EnsureResult, InstanceManagerDeps, LiveInstance } from './types';

/**
 * The instance lifecycle of 8.6, on the owner worker:
 * absent -> starting{claiming, binding, installing, spawning, connecting} -> ready -> idle -> stopping -> absent,
 * with `failed` (backoff) -> absent.
 */

export type {
  EnsureArgs,
  EnsureResult,
  InstanceManagerDeps,
  LiveInstance,
} from './types';

const START_WAIT_POLL_MS = 250;
const DEFAULT_IDLE_MINUTES = 15;
const DEFAULT_TOUCH_PERSIST_MS = 30 * MS.SECOND;

export class InstanceManager {
  private readonly live = new Map<string, LiveInstance>();
  private readonly starting = new Map<string, Promise<EnsureResult>>();
  private readonly inflightCounter: InflightCounter;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly telemetry: InstanceTelemetry;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: InstanceManagerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.telemetry = deps.telemetry ?? noopInstanceTelemetry;
    this.inflightCounter = new InflightCounter(deps.redis);
  }

  get(instanceId: string): LiveInstance | undefined {
    return this.live.get(instanceId);
  }

  liveInstances(): LiveInstance[] {
    return [...this.live.values()];
  }

  // --- instance rows ------------------------------------------------------------------------------------------

  /**
   * The row for an installation: one per installation for per-user instances; for shared pools (8.6) the replica with
   * the fewest in-flight calls, growing the pool up to the catalog's replica count.
   */
  async instanceFor(installation: ResolvedInstallation): Promise<InstanceRecord> {
    const kind = installation.spec.type === 'package' ? 'sandbox' : 'remote-legacy';
    if (isSharedPackage(installation)) {
      const rows = await this.deps.repo.listShared(installation.catalogVersionId);
      const loads = await Promise.all(
        rows.map(async (row) => ({ row, load: await this.inflightCounter.get(row.id) })),
      );
      const picked = pickSharedReplica(loads, installation.replicas);
      if (picked) return picked;
      return this.createRecord(installation, kind, rows.length);
    }
    const existing = await this.deps.repo.getForInstallation(installation.installationId);
    if (existing) return existing;
    return this.createRecord(installation, kind, 0);
  }

  private async createRecord(
    installation: ResolvedInstallation,
    kind: InstanceRecord['kind'],
    replica: number,
  ): Promise<InstanceRecord> {
    const created = newInstanceRecord(installation, kind, replica, this.clock.now());
    await this.deps.repo.save(created);
    return created;
  }

  /** The existing row of an installation (or the first shared pool member) without creating one. */
  async getRecord(installation: ResolvedInstallation): Promise<InstanceRecord | null> {
    if (isSharedPackage(installation)) {
      return (await this.deps.repo.listShared(installation.catalogVersionId))[0] ?? null;
    }
    return this.deps.repo.getForInstallation(installation.installationId);
  }

  // --- ensuring a live connection --------------------------------------------------------------------------------

  /**
   * Returns the live local instance (single-flighted for concurrent callers), or tells the caller which worker owns
   * it (21.2). Start-on-first-use, version-change recycling and failure backoff happen here.
   */
  async ensure(args: EnsureArgs): Promise<EnsureResult> {
    const id = args.record.id;
    const existing = this.live.get(id);
    if (existing && !existing.stopping) {
      if (existing.versionId === args.installation.catalogVersionId) {
        return { kind: 'local', live: existing };
      }
      // Version change: finish in-flight calls, then restart with the new version (8.6).
      await this.drained(existing);
      await this.stop(id, 'version');
    }
    const pending = this.starting.get(id);
    if (pending) return pending;
    const run = this.acquire(args).finally(() => this.starting.delete(id));
    this.starting.set(id, run);
    return run;
  }

  private async acquire(args: EnsureArgs): Promise<EnsureResult> {
    const id = args.record.id;
    const result = await this.deps.leases.acquire(id, {
      attach: () => this.startOrAttach(args),
      onLost: () => void this.dropLocal(id),
    });
    if (result.kind === 'forward') return result;
    const live = this.live.get(id);
    if (live) return { kind: 'local', live };
    // Lease says ours but nothing is connected (a crash released nothing): start again.
    await this.deps.leases.release(id);
    const again = await this.deps.leases.acquire(id, {
      attach: () => this.startOrAttach(args),
      onLost: () => void this.dropLocal(id),
    });
    if (again.kind === 'forward') return again;
    const started = this.live.get(id);
    if (!started)
      throw new SandboxStartFailedError('instance did not start', {
        installation: args.installation.slug,
        phase: 'connecting',
      });
    return { kind: 'local', live: started };
  }

  private async startOrAttach(args: EnsureArgs): Promise<void> {
    const { record, installation } = args;
    let fresh = (await this.deps.repo.get(record.id)) ?? record;
    // A failure belongs to the configuration that produced it: a new catalog version (a fixed spec) starts clean
    // instead of waiting out the backoff of the old one (8.6).
    if (
      fresh.failures.length > 0 &&
      fresh.runningVersionId !== undefined &&
      fresh.runningVersionId !== installation.catalogVersionId
    ) {
      fresh = { ...fresh, failures: [], error: undefined };
      await this.deps.repo.save(fresh).catch(() => undefined);
      if (fresh.installationId) {
        await this.deps.status.clearError(fresh.installationId).catch(() => undefined);
      }
    }
    // Failure backoff: calls fail fast with -32016 until it passes or the user restarts (8.6).
    const decision = retryDecision(fresh.failures, this.clock.now());
    if (!decision.allowed) {
      throw new SandboxStartFailedError(
        `the server failed to start recently; retrying in ${Math.ceil(decision.retryInMs / 1000)} s or on Restart`,
        { installation: installation.slug, phase: fresh.error?.phase ?? 'start' },
      );
    }
    await this.singleFlightStart(record.id, async () => {
      if (installation.spec.type === 'package') {
        await this.startSandbox({ ...args, record: fresh }, installation.spec);
      } else {
        await this.startRemote({ ...args, record: fresh });
      }
    });
  }

  /** `start:{instanceId}` (NX, 120 s): a previous owner may still be mid-start; wait for it to finish (21.2). */
  private async singleFlightStart(instanceId: string, fn: () => Promise<void>): Promise<void> {
    const key = redisKeys.start(instanceId);
    const me = this.deps.registry.workerId;
    const deadline = this.clock.now() + TTL.startSingleFlight * 1000;
    while (this.clock.now() < deadline) {
      const got = await this.deps.redis.set(key, me, 'EX', TTL.startSingleFlight, 'NX');
      if (got === 'OK') {
        try {
          return await fn();
        } finally {
          const holder = await this.deps.redis.get(key).catch(() => null);
          if (holder === me) await this.deps.redis.del(key).catch(() => 0);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, START_WAIT_POLL_MS));
    }
    throw new Error(`timed out waiting for another worker to start instance ${instanceId}`);
  }

  // --- sandbox start and attach -----------------------------------------------------------------------------------

  private async startSandbox(args: EnsureArgs, spec: PackageSpec): Promise<void> {
    const { installation } = args;
    let { record } = args;
    const attributes = {
      [SPAN_ATTRS.instanceId]: record.id,
      [SPAN_ATTRS.installationId]: installation.installationId,
      [SPAN_ATTRS.sandboxDriver]: this.deps.driver.name,
    };
    await this.telemetry.acquire(attributes, async (events) => {
      if (record.sandbox) {
        const attached = await this.tryAttach(record, args, events);
        if (attached) return;
        // Attach failed: start fresh (21.2). The old claim is released.
        record = await this.discardSandbox(record);
      }
      await this.startFresh({ ...args, record }, spec, events);
    });
  }

  private async tryAttach(
    record: InstanceRecord,
    args: EnsureArgs,
    events: AcquireEvents,
  ): Promise<boolean> {
    const sandbox = record.sandbox;
    if (!sandbox) return false;
    const token = await this.deps.tokens.load(record.id);
    if (!token) return false;
    let handle: SandboxHandle | undefined;
    try {
      handle = await this.deps.driver.attach({ ...sandbox, runnerToken: token }, args.signal);
      const health = await handle.runner.health(args.signal);
      if (health.state !== 'running') return false;
      // The new runner WebSocket replaces any old one (21.2).
      const live = await this.connectSandbox(args, record, handle, events, this.clock.now());
      this.register(live);
      return true;
    } catch (error) {
      this.logger.warn('attach failed', { instanceId: record.id, error: String(error) });
      return false;
    }
  }

  private async discardSandbox(record: InstanceRecord): Promise<InstanceRecord> {
    const ref = record.sandbox
      ? { ...record.sandbox, runnerToken: (await this.deps.tokens.load(record.id)) ?? '' }
      : undefined;
    return this.releaseSandboxArtifacts(record, ref, 'as-is');
  }

  /**
   * Destroys the sandbox (when there is one) and forgets everything kept for it: runner token, egress policy and the
   * `sandbox` mark on the row. `reload` re-reads the row first and swallows save errors (cleanup after a failure);
   * `as-is` saves `record` and lets errors through.
   */
  private async releaseSandboxArtifacts(
    record: InstanceRecord,
    ref: SandboxHandle['ref'] | undefined,
    mode: 'reload' | 'as-is',
  ): Promise<InstanceRecord> {
    if (ref) {
      await this.deps.driver
        .destroy(ref)
        .catch((error) => this.logger.warn('destroy failed', { error: String(error) }));
    }
    await swallow(this.deps.tokens.delete(record.id));
    await swallow(this.deps.egress.delete(record.id));
    if (mode === 'as-is') {
      const cleared = { ...record, sandbox: undefined };
      await this.deps.repo.save(cleared);
      return cleared;
    }
    const latest = (await this.deps.repo.get(record.id)) ?? record;
    const cleared = { ...latest, sandbox: undefined };
    await swallow(this.deps.repo.save(cleared));
    return cleared;
  }

  private async startFresh(
    args: EnsureArgs,
    spec: PackageSpec,
    events: AcquireEvents,
  ): Promise<void> {
    const { installation, principal, credential, signal, record } = args;
    const progress = new StartProgress();
    const started = this.clock.now();
    const egressToken = randomBytes(32).toString('hex');
    try {
      // Resolve every template first: a bad setting must not cost a sandbox claim.
      const request = buildStartRequest(installation, principal, credential, {
        proxyUrl: buildProxyUrl(record.id, egressToken, this.deps.egressAddress),
        npmRegistry: this.deps.npmRegistry,
        pypiIndexUrl: this.deps.pypiIndexUrl,
      });
      await this.makeRoom(record);
      const handle = await this.claimSandbox(args, spec, progress, events);
      const updated = await this.bindSandbox(
        record,
        installation,
        handle,
        started,
        events,
        progress,
      );
      await this.installAndSpawn(
        { record: updated, installation, spec, handle, request, egressToken, signal },
        progress,
        events,
      );
      progress.setPhase('connecting');
      const live = await this.connectSandbox(args, updated, handle, events, started);
      progress.apply({ type: 'connected' });
      live.state = progress.state;
      this.register(live);
      this.recordStartMetrics('ok', started);
      await this.clearErrorIfAny(updated);
    } catch (error) {
      progress.apply({ type: 'fail' });
      // A cap is not a failure of the server: no backoff, the caller sees -32011 (8.6).
      if (error instanceof RateLimitedError) throw error;
      await this.onStartFailed(record, progress.phase, error, progress.handle);
      this.recordStartMetrics('failed', started);
      throw new SandboxStartFailedError(
        error instanceof Error ? error.message : String(error),
        { installation: installation.slug, phase: progress.phase },
        error,
      );
    }
  }

  private recordStartMetrics(outcome: 'ok' | 'failed', startedAt: number): void {
    const driver = this.deps.driver.name;
    this.deps.metrics?.sandboxStarts.add(1, { driver, outcome, warm: false });
    if (outcome === 'ok') {
      this.deps.metrics?.sandboxStartDuration.record((this.clock.now() - startedAt) / MS.SECOND, {
        driver,
        phase: 'total',
      });
    }
  }

  /** Claiming: the driver creates the sandbox. `progress.handle` is set at once so a failure can destroy it. */
  private async claimSandbox(
    args: EnsureArgs,
    spec: PackageSpec,
    progress: StartProgress,
    events: AcquireEvents,
  ): Promise<SandboxHandle> {
    const { record } = args;
    const sandboxSpec: SandboxSpec = {
      instanceId: record.id,
      installationId: record.installationId,
      userId: record.userId,
      size: spec.size,
      workspace: spec.workspace,
    };
    const handle = await this.deps.driver.create(sandboxSpec, args.signal);
    progress.handle = handle;
    events.add('claimed');
    return handle;
  }

  /** Binding: the runner token and the sandbox reference are persisted so another worker can attach (21.2). */
  private async bindSandbox(
    record: InstanceRecord,
    installation: ResolvedInstallation,
    handle: SandboxHandle,
    startedAt: number,
    events: AcquireEvents,
    progress: StartProgress,
  ): Promise<InstanceRecord> {
    progress.enter('binding');
    events.add('bound');
    await this.deps.tokens.save(record.id, handle.ref.runnerToken);
    const updated: InstanceRecord = {
      ...record,
      sandbox: { driver: handle.ref.driver, id: handle.ref.id, address: handle.ref.address },
      startedAt,
      runningVersionId: installation.catalogVersionId,
    };
    await this.deps.repo.save(updated);
    return updated;
  }

  /** Installing and spawning: the runner installs the package and starts the server; the egress phase follows it. */
  private async installAndSpawn(
    run: {
      record: InstanceRecord;
      installation: ResolvedInstallation;
      spec: PackageSpec;
      handle: SandboxHandle;
      request: Parameters<typeof startAndWait>[1];
      egressToken: string;
      signal: AbortSignal;
    },
    progress: StartProgress,
    events: AcquireEvents,
  ): Promise<void> {
    const { record, installation, spec, handle, request, egressToken, signal } = run;
    const policy = { tokenSha256: sha256Hex(egressToken), allow: spec.egress.allow };
    await this.deps.egress.set(record.id, { ...policy, phase: 'installing' });
    progress.enter('installing');
    await startAndWait(
      handle.runner,
      request,
      { installation: installation.slug },
      (event) => {
        if (event.phase === 'starting') {
          events.add('installed');
          progress.enter('spawning');
          void this.deps.egress.set(record.id, { ...policy, phase: 'starting' });
        } else if (event.phase === 'ready') {
          events.add('spawned');
          progress.enter('connecting');
          void this.deps.egress.set(record.id, { ...policy, phase: 'running' });
        }
      },
      signal,
    );
  }

  /** The one-off lockfile sandbox of 8.7: see `captureLockfileIn`. */
  captureLockfile(
    spec: PackageSpec,
    context: { userId: string | null; label: string; signal?: AbortSignal },
  ): ReturnType<typeof captureLockfileIn> {
    return captureLockfileIn(this.deps, spec, context);
  }

  private async clearErrorIfAny(record: InstanceRecord): Promise<void> {
    if (record.error === undefined && record.failures.length === 0) return;
    const cleared: InstanceRecord = { ...record, error: undefined, failures: record.failures };
    await this.deps.repo.save(cleared);
    if (record.installationId) await swallow(this.deps.status.clearError(record.installationId));
  }

  /** Per-user and org caps (8.6): stop the least recently used idle-eligible instance, else `-32011`. */
  private async makeRoom(record: InstanceRecord): Promise<void> {
    const check = async (userId: string | undefined, max: number): Promise<void> => {
      const rows = await this.deps.repo.listRunning(userId);
      const infos: SandboxInstanceInfo[] = await Promise.all(
        rows
          .filter((row) => row.id !== record.id)
          .map(async (row) => ({
            id: row.id,
            state: 'running',
            idleEligible: (await this.inflightCounter.get(row.id)) === 0,
            lastUsedAt: row.lastUsedAt,
          })),
      );
      const plan = planSandboxStart(infos, max);
      if (plan.action === 'reject') throw plan.error;
      if (plan.action === 'stop-then-start') await this.stopAnywhere(plan.stopInstanceId);
    };
    if (record.userId) await check(record.userId, this.deps.limits.maxRunningPerUser);
    await check(undefined, this.deps.limits.maxRunningTotal);
  }

  private async connectSandbox(
    args: EnsureArgs,
    record: InstanceRecord,
    handle: SandboxHandle,
    events: AcquireEvents,
    startedAt: number,
  ): Promise<LiveInstance> {
    const { installation, principal, credential, signal } = args;
    const stderr = new StderrPipeline({
      instanceId: record.id,
      installationId: record.installationId,
      ...(this.deps.stderrSink ? { sink: this.deps.stderrSink } : {}),
      ...(this.deps.stderrLogger ? { logger: this.deps.stderrLogger } : {}),
    });
    const continuations = new ContinuationRegistry({
      redis: this.deps.redis,
      workerId: this.deps.registry.workerId,
      instanceId: record.id,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    });
    const channel = await handle.runner.openStdio(signal);
    let session: UpstreamSession;
    try {
      session = await this.deps.connectors.sandbox.connect({
        installation,
        principal,
        credential,
        instanceId: record.id,
        signal,
        continuations,
        sandbox: { channel, onStderr: (line) => stderr.handle(line) },
      });
    } catch (error) {
      await channel.close().catch(() => undefined);
      throw error;
    }
    events.add('connected');
    return this.makeLive(
      args,
      record,
      installation,
      session,
      continuations,
      startedAt,
      handle,
      stderr,
    );
  }

  // --- remote legacy sessions ------------------------------------------------------------------------------------------

  private async startRemote(args: EnsureArgs): Promise<void> {
    const { installation, principal, credential, signal, record } = args;
    if (installation.spec.type !== 'remote') return;
    const connector =
      installation.spec.transport === 'sse' ? this.deps.connectors.sse : this.deps.connectors.http;
    const attributes = {
      [SPAN_ATTRS.instanceId]: record.id,
      [SPAN_ATTRS.installationId]: installation.installationId,
    };
    await this.telemetry.acquire(attributes, async (events) => {
      const continuations = new ContinuationRegistry({
        redis: this.deps.redis,
        workerId: this.deps.registry.workerId,
        instanceId: record.id,
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      });
      const started = this.clock.now();
      let session: UpstreamSession;
      try {
        // A legacy remote reuses the stored Mcp-Session-Id and reopens its GET stream; else it starts fresh (21.2).
        session = await connector.connect({
          installation,
          principal,
          credential,
          instanceId: record.id,
          signal,
          prior: { kind: 'legacy' },
          continuations,
          ...(record.remoteSession ? { remoteSession: record.remoteSession } : {}),
        });
      } catch (error) {
        await this.recordFailureOf(record, 'connecting', error);
        throw error;
      }
      events.add('connected');
      const remoteSession = session.sessionId
        ? {
            sessionId: session.sessionId,
            protocolVersion: session.protocolVersion ?? '',
            url: record.remoteSession?.url ?? '',
            serverCapabilities: session.serverCapabilities,
          }
        : undefined;
      const updated: InstanceRecord = { ...record, remoteSession, startedAt: started };
      await this.deps.repo.save(updated);
      this.register(this.makeLive(args, updated, installation, session, continuations, started));
    });
  }

  // --- bookkeeping ---------------------------------------------------------------------------------------------------

  private makeLive(
    args: Pick<EnsureArgs, 'principal' | 'credential'>,
    record: InstanceRecord,
    installation: ResolvedInstallation,
    session: UpstreamSession,
    continuations: ContinuationRegistry,
    startedAt: number,
    handle?: SandboxHandle,
    stderr?: StderrPipeline,
  ): LiveInstance {
    const now = this.clock.now();
    return {
      id: record.id,
      record,
      installation,
      session,
      continuations,
      handle,
      stderr,
      state: { kind: 'ready' },
      startedAt,
      versionId: installation.catalogVersionId,
      credentialHash: args.credential.credentialHash,
      principalId: args.principal.userId,
      inflight: 0,
      lastUsedAt: now,
      stopping: false,
      drainWaiters: [],
      lastPersistedAt: now,
    };
  }

  private register(live: LiveInstance): void {
    this.live.set(live.id, live);
    live.session.onClose((info) => void this.onSessionClosed(live, info));
    this.armIdle(live);
    this.ensureSweeper();
    this.deps.metrics?.instancesActive.record(this.live.size, {
      kind: live.handle ? 'sandbox' : 'remote',
    });
  }

  private idleMs(live: LiveInstance): number {
    const minutes =
      live.installation.spec.type === 'package'
        ? live.installation.spec.idleTimeoutMinutes
        : DEFAULT_IDLE_MINUTES;
    return minutes * MS.MINUTE;
  }

  private armIdle(live: LiveInstance): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (live.inflight > 0 || live.stopping) return;
    live.idleTimer = setTimeout(() => void this.idleCheck(live), this.idleMs(live));
    live.idleTimer.unref?.();
  }

  private async idleCheck(live: LiveInstance): Promise<void> {
    if (live.stopping || this.live.get(live.id) !== live) return;
    if (live.inflight > 0 || live.continuations.size > 0) {
      this.armIdle(live);
      return;
    }
    const idleFor = this.clock.now() - live.lastUsedAt;
    if (idleFor < this.idleMs(live)) {
      this.armIdle(live);
      return;
    }
    const next = instanceStateMachine(live.state, { type: 'idleTimeout' });
    if (next.ok) live.state = next.state;
    await this.stop(live.id, 'idle');
  }

  /** A safety net for instances whose timers were lost (fake clocks, long suspends). */
  private ensureSweeper(): void {
    if (this.sweeper || !this.deps.idleSweepMs) return;
    this.sweeper = setInterval(() => {
      for (const live of this.live.values()) void this.idleCheck(live);
    }, this.deps.idleSweepMs);
    this.sweeper.unref?.();
  }

  /** Runs one operation on a live instance, tracking in-flight calls for idle, LRU and version changes. */
  async run<T>(live: LiveInstance, fn: (session: UpstreamSession) => Promise<T>): Promise<T> {
    live.inflight += 1;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    const activity = instanceStateMachine(live.state, { type: 'activity' });
    if (activity.ok) live.state = activity.state;
    await this.inflightCounter.incr(live.id).catch(() => 0);
    try {
      return await fn(live.session);
    } finally {
      live.inflight -= 1;
      live.lastUsedAt = this.clock.now();
      await this.inflightCounter.decr(live.id).catch(() => 0);
      if (live.inflight === 0) {
        for (const waiter of live.drainWaiters.splice(0)) waiter();
        this.armIdle(live);
      }
      void this.persistUse(live);
    }
  }

  private async persistUse(live: LiveInstance): Promise<void> {
    const now = this.clock.now();
    if (now - live.lastPersistedAt < (this.deps.touchPersistMs ?? DEFAULT_TOUCH_PERSIST_MS)) return;
    live.lastPersistedAt = now;
    live.record = { ...live.record, lastUsedAt: now };
    await this.deps.repo.save(live.record).catch(() => undefined);
  }

  private drained(live: LiveInstance): Promise<void> {
    if (live.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => live.drainWaiters.push(resolve));
  }

  // --- failure handling ------------------------------------------------------------------------------------------------

  private async recordFailureOf(
    record: InstanceRecord,
    phase: string,
    error: unknown,
    stderrTail: string[] = [],
  ): Promise<void> {
    const { updated, message, markInstallation } = failureRecord(
      record,
      phase,
      error,
      stderrTail,
      this.clock.now(),
    );
    await swallow(this.deps.repo.save(updated));
    if (markInstallation && record.installationId) {
      await swallow(
        this.deps.status.markError(record.installationId, { phase, message, stderrTail }),
      );
    }
  }

  private async onStartFailed(
    record: InstanceRecord,
    phase: InstanceStartPhase,
    error: unknown,
    handle: SandboxHandle | undefined,
  ): Promise<void> {
    const latest = (await this.deps.repo.get(record.id)) ?? record;
    await this.recordFailureOf(latest, phase, error);
    await this.releaseSandboxArtifacts(record, handle?.ref, 'reload');
  }

  /** The server exited, the socket closed, or another owner took over (8.6, 21.2). */
  private async onSessionClosed(live: LiveInstance, info: CloseInfo): Promise<void> {
    if (live.stopping || this.live.get(live.id) !== live) return;
    this.live.delete(live.id);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    await live.continuations.closeAll().catch(() => undefined);
    for (const waiter of live.drainWaiters.splice(0)) waiter();
    if (info.closeCode === CLOSE_CODE_REPLACED) {
      // Replaced by a newer owner (21.2): nothing to clean up here.
      this.logger.info('instance taken over by another owner', { instanceId: live.id });
      await this.deps.leases.release(live.id);
      return;
    }
    const now = this.clock.now();
    if (info.exit !== undefined) {
      this.logger.warn('sandboxed server exited', { instanceId: live.id, exit: info.exit });
      if (crashCountsAsFailure(live.startedAt, now)) {
        await this.recordFailureOf(
          live.record,
          'spawning',
          new Error(`server exited (code ${info.exit.code})`),
          live.stderr?.tail.tail(50) ?? [],
        );
      }
      if (live.handle) await this.releaseSandboxArtifacts(live.record, live.handle.ref, 'reload');
    }
    await this.deps.leases.release(live.id);
  }

  /** The lease could not be renewed: close the connection but leave the sandbox running (21.2). */
  async dropLocal(instanceId: string): Promise<void> {
    const live = this.live.get(instanceId);
    if (!live) return;
    live.stopping = true;
    this.live.delete(instanceId);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    await live.session.close().catch(() => undefined);
  }

  // --- stopping -----------------------------------------------------------------------------------------------------------

  /** idle -> stopping -> absent; persistent workspaces are suspended instead of destroyed (8.6). */
  async stop(
    instanceId: string,
    reason: 'idle' | 'evict' | 'version' | 'restart' | 'shutdown',
  ): Promise<void> {
    const live = this.live.get(instanceId);
    if (!live || live.stopping) return;
    live.stopping = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    const stopping = instanceStateMachine(live.state, { type: 'stop' });
    if (stopping.ok) live.state = stopping.state;
    this.logger.info('stopping instance', { instanceId, reason });
    await live.session.close().catch(() => undefined);
    const ref = live.handle?.ref;
    if (ref && live.handle) {
      await live.handle.runner.stop().catch(() => undefined);
      const spec = live.installation.spec;
      if (spec.type === 'package' && spec.workspace.persistent) {
        await swallow(this.deps.driver.suspend(ref));
        await swallow(this.deps.egress.delete(instanceId));
      } else {
        await this.releaseSandboxArtifacts(live.record, ref, 'reload');
      }
    }
    this.live.delete(instanceId);
    const done = instanceStateMachine(live.state, { type: 'stopped' });
    if (done.ok) live.state = done.state;
    await this.deps.leases.release(instanceId);
    await live.continuations.closeAll().catch(() => undefined);
  }

  /** Stops an instance whichever worker owns it (LRU eviction, 8.6). */
  async stopAnywhere(instanceId: string): Promise<void> {
    if (this.live.has(instanceId)) return this.stop(instanceId, 'evict');
    const record = await this.deps.repo.get(instanceId);
    if (!record?.sandbox) return;
    const token = (await this.deps.tokens.load(instanceId)) ?? '';
    await this.releaseSandboxArtifacts(record, { ...record.sandbox, runnerToken: token }, 'as-is');
  }

  /** The user clicked Restart: clears failures and the `error` mark, then stops (8.6). */
  async restart(instanceId: string): Promise<void> {
    const record = await this.deps.repo.get(instanceId);
    if (record) {
      await this.deps.repo.save({ ...record, failures: [], error: undefined });
      if (record.installationId) {
        await this.deps.status.clearError(record.installationId).catch(() => undefined);
      }
    }
    await this.stop(instanceId, 'restart');
  }

  /** Graceful shutdown: close every connection WITHOUT stopping sandboxes (21.2). */
  async closeConnections(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const live of [...this.live.values()]) {
      live.stopping = true;
      if (live.idleTimer) clearTimeout(live.idleTimer);
      await live.session.close().catch(() => undefined);
    }
    this.live.clear();
  }
}
