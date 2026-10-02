import { randomBytes } from 'node:crypto';
import { SandboxStartFailedError } from '@bastion-mcp/core';
import { HttpRunnerClient, parseRunnerAddress } from '../runner-client';
import {
  type Clock,
  type IsolationLevel,
  type RunnerClient,
  type SandboxDriver,
  type SandboxHandle,
  type SandboxRef,
  type SandboxSpec,
  systemClock,
} from '../types';
import {
  bastionSelector,
  boundSandboxName,
  buildClaim,
  type GcDecision,
  type GcKnownState,
  installationSelector,
  isPersistentClaimName,
  type KubeObject,
  LABELS,
  operatingModePatch,
  refreshShutdownPatch,
  runnerAddressOf,
  SHUTDOWN_REFRESH_INTERVAL_MS,
  selectClaimsToDelete,
  warmPoolName,
} from './crd';
import { type KubeApi, KubeApiError } from './kube-api';

export type KubernetesDriverOptions = {
  api: KubeApi;
  /** `BASTION_SANDBOX_NAMESPACE` (default `bastion-sandboxes`). */
  namespace?: string;
  /** `gvisor` by default; `kata` when `sandbox.runtimeClassName` selects Kata (8.4). */
  isolation?: Extract<IsolationLevel, 'gvisor' | 'kata'>;
  clock?: Clock;
  tokenFactory?: () => string;
  runnerFactory?: (address: string) => RunnerClient;
  poolName?: (size: SandboxSpec['size'], persistent: boolean) => string;
  storageClassName?: string;
  claimTimeoutMs?: number;
  runnerReadyTimeoutMs?: number;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Production driver on the agent-sandbox project (8.4). Isolation comes from the pool's RuntimeClass. */
export class KubernetesDriver implements SandboxDriver {
  readonly name = 'kubernetes' as const;
  readonly isolation: IsolationLevel;
  private readonly api: KubeApi;
  private readonly namespace: string;
  private readonly clock: Clock;

  constructor(private readonly options: KubernetesDriverOptions) {
    this.api = options.api;
    this.namespace = options.namespace ?? 'bastion-sandboxes';
    this.isolation = options.isolation ?? 'gvisor';
    this.clock = options.clock ?? systemClock;
  }

  private failure(
    spec: { instanceId: string; installationId: string | null },
    phase: string,
    message: string,
  ): SandboxStartFailedError {
    return new SandboxStartFailedError(message, {
      installation: spec.installationId ?? spec.instanceId,
      phase,
    });
  }

  private makeRunner(address: string): RunnerClient {
    return this.options.runnerFactory
      ? this.options.runnerFactory(address)
      : new HttpRunnerClient(parseRunnerAddress(address));
  }

  /** Watches the claim until `status.sandbox.podIPs` or `serviceFQDN` is set (8.4). */
  private async waitForAddress(
    name: string,
    signal: AbortSignal,
  ): Promise<{ address: string; claim: KubeObject }> {
    const deadline = AbortSignal.timeout(this.options.claimTimeoutMs ?? 120_000);
    const stop = AbortSignal.any([signal, deadline]);
    while (!stop.aborted) {
      for await (const claim of this.api.watchClaim(name, stop)) {
        const address = runnerAddressOf(claim);
        if (address) return { address, claim };
      }
      await sleep(500, stop);
    }
    throw new Error(
      signal.aborted ? 'start aborted' : 'timed out waiting for the sandbox claim to bind a pod',
    );
  }

  private async waitForRunner(
    runner: RunnerClient,
    signal: AbortSignal,
  ): Promise<'unbound' | 'bound' | 'running'> {
    const deadline = AbortSignal.timeout(this.options.runnerReadyTimeoutMs ?? 60_000);
    const stop = AbortSignal.any([signal, deadline]);
    let last: unknown;
    while (!stop.aborted) {
      try {
        return (await runner.health(stop)).state;
      } catch (error) {
        last = error;
        await sleep(250, stop);
      }
    }
    throw new Error(
      `runner did not answer /healthz${last instanceof Error ? `: ${last.message}` : ''}`,
    );
  }

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
    if (spec.minIsolation === 'kata' && this.isolation !== 'kata') {
      throw this.failure(
        spec,
        'claiming',
        `catalog entry requires kata isolation; this driver provides ${this.isolation}`,
      );
    }
    const claim = buildClaim({
      spec,
      namespace: this.namespace,
      nowMs: this.clock.now(),
      ...(this.options.storageClassName ? { storageClassName: this.options.storageClassName } : {}),
      poolName: (this.options.poolName ?? warmPoolName)(spec.size, spec.workspace.persistent),
    });
    const name = claim.metadata.name;
    const persistent = spec.workspace.persistent;
    let created = false;
    try {
      const existing = await this.api.get('claim', name, signal);
      if (existing && !persistent) {
        throw this.failure(spec, 'claiming', `sandbox claim ${name} already exists`);
      }
      if (!existing) {
        try {
          await this.api.create('claim', claim, signal);
          created = true;
        } catch (error) {
          if (error instanceof KubeApiError && error.status === 409) {
            throw this.failure(spec, 'claiming', `sandbox claim ${name} already exists`);
          }
          throw error;
        }
      } else {
        // Resume of a suspended persistent workspace (8.4): flip the bound Sandbox back to Running.
        const sandboxName = boundSandboxName(existing);
        if (sandboxName)
          await this.api.patch('sandbox', sandboxName, operatingModePatch('Running'), signal);
      }
      const { address } = await this.waitForAddress(name, signal);
      const runner = this.makeRunner(address);
      const state = await this.waitForRunner(runner, signal);
      if (state !== 'unbound') {
        throw new Error(`runner is already ${state}; use attach() with the stored token`);
      }
      const runnerToken = (this.options.tokenFactory ?? (() => randomBytes(32).toString('hex')))();
      await runner.bind(runnerToken, signal);
      return { ref: { driver: 'kubernetes', id: name, address, runnerToken }, runner };
    } catch (error) {
      if (created && !persistent) await this.api.delete('claim', name).catch(() => {});
      if (error instanceof SandboxStartFailedError) throw error;
      throw this.failure(spec, 'claiming', error instanceof Error ? error.message : String(error));
    }
  }

  /** New owner after a lease change (21.2): reuse the stored token against the same runner. */
  async attach(ref: SandboxRef, signal: AbortSignal): Promise<SandboxHandle> {
    const fail = (message: string): SandboxStartFailedError =>
      new SandboxStartFailedError(message, { installation: ref.id, phase: 'claiming' });
    const claim = await this.api.get('claim', ref.id, signal);
    if (!claim) throw fail(`sandbox claim ${ref.id} no longer exists`);
    const address = runnerAddressOf(claim) ?? ref.address;
    const runner = this.makeRunner(address);
    runner.useToken(ref.runnerToken);
    try {
      await runner.health(signal);
    } catch (error) {
      throw fail(
        `runner of ${ref.id} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ref: { ...ref, address }, runner };
  }

  /** Persistent workspaces only: the controller deletes the pod and keeps the PVC (8.4). */
  async suspend(ref: SandboxRef): Promise<void> {
    if (!isPersistentClaimName(ref.id)) {
      throw new Error('suspend is only available for persistent workspaces');
    }
    const claim = await this.api.get('claim', ref.id);
    const sandboxName = claim ? boundSandboxName(claim) : null;
    if (!sandboxName) return;
    await this.api.patch('sandbox', sandboxName, operatingModePatch('Suspended'));
  }

  /**
   * Deletes the claim, its `Sandbox` and, for a persistent workspace, its PVCs (uninstall, 8.4).
   * Ephemeral instances are normally ended by deleting only the claim.
   */
  async destroy(ref: SandboxRef): Promise<void> {
    const claim = await this.api.get('claim', ref.id);
    const sandboxName = claim ? boundSandboxName(claim) : null;
    await this.api.delete('claim', ref.id);
    if (sandboxName) await this.api.delete('sandbox', sandboxName);
    if (isPersistentClaimName(ref.id)) {
      const installation = claim?.metadata.labels?.[LABELS.installation];
      if (installation) await this.api.deleteMatching('pvc', installationSelector(installation));
    }
  }

  async *list(): AsyncIterable<SandboxRef> {
    for (const claim of await this.api.list('claim', bastionSelector)) {
      yield {
        driver: 'kubernetes',
        id: claim.metadata.name,
        address: runnerAddressOf(claim) ?? '',
        runnerToken: '',
      };
    }
  }

  /** Extends `shutdownTime` to now + 24 h; call hourly while the instance is in use (8.4). */
  async refreshShutdownTime(ref: SandboxRef): Promise<void> {
    if (isPersistentClaimName(ref.id)) return; // persistent claims carry no shutdownTime
    await this.api.patch('claim', ref.id, refreshShutdownPatch(this.clock.now()));
  }

  /** Hourly refresh timer for one in-use instance. */
  keepAlive(ref: SandboxRef, onError: (error: unknown) => void = () => {}): { stop(): void } {
    const timer = setInterval(() => {
      this.refreshShutdownTime(ref).catch(onError);
    }, SHUTDOWN_REFRESH_INTERVAL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  /**
   * Garbage collection (8.4), run by the ui scheduler every 5 minutes: claims and sandboxes labeled by
   * Bastion whose instance is not in Postgres, or whose lease expired more than 10 minutes ago, are deleted.
   */
  async collectGarbage(known: GcKnownState): Promise<GcDecision[]> {
    const now = this.clock.now();
    const claims = await this.api.list('claim', bastionSelector);
    const decisions = selectClaimsToDelete(claims, known, now);
    for (const decision of decisions) {
      const claim = claims.find((c) => c.metadata.name === decision.name);
      if (claim) {
        await this.destroy({
          driver: 'kubernetes',
          id: decision.name,
          address: '',
          runnerToken: '',
        });
      }
    }
    const sandboxes = await this.api.list('sandbox', bastionSelector);
    for (const decision of selectClaimsToDelete(sandboxes, known, now)) {
      await this.api.delete('sandbox', decision.name);
      decisions.push(decision);
    }
    return decisions;
  }
}
