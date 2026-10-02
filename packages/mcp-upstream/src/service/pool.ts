import { extractReferences } from '@bastion-mcp/core';
import type { EraCache } from '../connectors/era-cache';
import type { UpstreamConnector, UpstreamSession } from '../connectors/types';
import {
  type CallPrincipal,
  type Clock,
  type Logger,
  noopLogger,
  type ResolvedCredential,
  type ResolvedInstallation,
  systemClock,
} from '../ports';

/**
 * Modern remote upstreams are stateless: each worker keeps a pool of SDK clients keyed by
 * `(installationId, credentialHash)` and any replica calls them directly (6.4).
 */

export const POOL_IDLE_MS = 5 * 60_000;

type Entry = {
  session: UpstreamSession;
  versionId: string;
  lastUsedAt: number;
  principalId: string;
};

/** Specs whose URL or headers mention `{{user.*}}` differ per user even with one shared credential. */
const perUserSpec = (installation: ResolvedInstallation): boolean => {
  const spec = installation.spec;
  if (spec.type !== 'remote') return false;
  const templates = [spec.url, ...(spec.headers ?? []).flatMap((h) => (h.value ? [h.value] : []))];
  return templates.some((t) => extractReferences(t).some((ref) => ref.startsWith('user.')));
};

export const poolKey = (
  installation: ResolvedInstallation,
  principal: CallPrincipal,
  credential: ResolvedCredential,
): string =>
  `${installation.installationId}:${credential.credentialHash}${perUserSpec(installation) ? `:${principal.userId}` : ''}`;

export type PoolConnectResult =
  | { era: 'modern'; session: UpstreamSession }
  | { era: 'legacy'; session?: undefined };

export class RemotePool {
  private readonly entries = new Map<string, Entry>();
  private readonly connecting = new Map<string, Promise<PoolConnectResult>>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      connector: UpstreamConnector;
      eraCache: EraCache;
      clock?: Clock;
      logger?: Logger;
      idleMs?: number;
    },
  ) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * A pooled session for a modern upstream. When the upstream turns out to be legacy the verdict is cached and
   * `{era: 'legacy'}` tells the caller to use an owned instance instead (21.2).
   */
  async get(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    signal: AbortSignal,
  ): Promise<PoolConnectResult> {
    const key = poolKey(installation, principal, credential);
    const entry = this.entries.get(key);
    if (entry && !entry.session.closed && entry.versionId === installation.catalogVersionId) {
      entry.lastUsedAt = this.clock.now();
      return { era: 'modern', session: entry.session };
    }
    if (entry) this.drop(key);
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const run = this.connect(key, installation, principal, credential, signal).finally(() =>
      this.connecting.delete(key),
    );
    this.connecting.set(key, run);
    return run;
  }

  private async connect(
    key: string,
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    signal: AbortSignal,
  ): Promise<PoolConnectResult> {
    const prior = await this.options.eraCache.get(
      installation.installationId,
      credential.credentialHash,
    );
    if (prior?.kind === 'legacy') return { era: 'legacy' };
    let verdict: Parameters<EraCache['put']>[2] | undefined;
    const session = await this.options.connector.connect({
      installation,
      principal,
      credential,
      instanceId: key,
      signal,
      ...(prior ? { prior } : {}),
      onVerdict: (v) => {
        verdict = v;
      },
    });
    if (verdict) {
      await this.options.eraCache.put(
        installation.installationId,
        credential.credentialHash,
        verdict,
      );
    }
    if (session.era === 'legacy') {
      // A legacy remote needs an owner worker and its session id (21.2): hand over to the instance path.
      await session.close().catch(() => undefined);
      return { era: 'legacy' };
    }
    this.entries.set(key, {
      session,
      versionId: installation.catalogVersionId,
      lastUsedAt: this.clock.now(),
      principalId: principal.userId,
    });
    session.onClose(() => {
      if (this.entries.get(key)?.session === session) this.entries.delete(key);
    });
    this.ensureSweeper();
    this.logger.debug('pooled a modern upstream session', { key });
    return { era: 'modern', session };
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    void entry?.session.close().catch(() => undefined);
  }

  /** Drops pooled sessions of one installation (credential changed, installation edited). */
  invalidate(installationId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${installationId}:`)) this.drop(key);
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  sweep(): void {
    const idle = this.options.idleMs ?? POOL_IDLE_MS;
    for (const [key, entry] of this.entries) {
      if (this.clock.now() - entry.lastUsedAt >= idle) this.drop(key);
    }
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const sessions = [...this.entries.values()].map((e) => e.session);
    this.entries.clear();
    await Promise.all(sessions.map((s) => s.close().catch(() => undefined)));
  }
}
