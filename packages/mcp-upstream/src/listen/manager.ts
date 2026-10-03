import { MS, redisKeys } from '@bastion-mcp/core';
import type { UpstreamSubscription } from '../connectors/types';
import type { UpstreamLists } from '../lists/source';
import { LEASE_TTL_MS } from '../ownership/lease';
import { COMPARE_AND_DELETE, COMPARE_AND_PEXPIRE, DECR_FLOOR } from '../ownership/lua';
import type { WorkerRegistry } from '../ownership/registry';
import {
  type CallPrincipal,
  type Clock,
  type InstallationRegistry,
  type ListKind,
  type Logger,
  noopLogger,
  type RedisLike,
  type ResolvedCredential,
  type ResolvedInstallation,
  systemClock,
  type UpstreamCredentialProvider,
} from '../ports';
import type { InternalRpcClient } from '../rpc/client';
import type { SubscriptionBody } from '../rpc/protocol';
import type { SessionInfo, UpstreamService } from '../service/service';
import { UPSTREAM_TIMEOUTS_MS } from '../timeouts';
import { toWireContext, type UpstreamCallContext, type UpstreamNotification } from '../types';
import { identityUriMapper, type NotifyPublisher, type UriMapper } from './events';

/**
 * Upstream notifications and subscriptions (6.6), upstream side.
 *
 * - Sandboxes and legacy remote sessions receive notifications on their owner worker (stdio channel or GET stream).
 * - For modern remote upstreams, the holder of lease `ulisten:{installationId}:{credentialHash}` opens ONE
 *   `client.listen(...)` per installation and credential, only while the reference count
 *   `listen:{installationId}:{credentialHash}` is above zero, and closes it 60 s after the last subscriber leaves.
 * - `notifications/resources/updated` is mapped back to the downstream URI; list changes invalidate the list cache and
 *   are published on `bastion:notify`.
 */

export const LISTEN_CLOSE_GRACE_MS = MS.MINUTE;
export const LISTEN_TICK_MS = 5 * MS.SECOND;

const NOTIFICATION_KIND: Record<string, ListKind> = {
  'notifications/tools/list_changed': 'tools',
  'notifications/prompts/list_changed': 'prompts',
  'notifications/resources/list_changed': 'resources',
};

type ListenArgs = {
  installation: ResolvedInstallation;
  principal: CallPrincipal;
  credential: ResolvedCredential;
};

type Held = {
  args: ListenArgs;
  subscription?: UpstreamSubscription | undefined;
  /** Upstream URIs with their local reference counts (this holder). */
  uris: Map<string, number>;
  zeroSince?: number | undefined;
  openedFilter?: string | undefined;
};

export type ListenManagerDeps = {
  service: UpstreamService;
  lists: UpstreamLists;
  publisher: NotifyPublisher;
  redis: RedisLike;
  registry: WorkerRegistry;
  rpc: InternalRpcClient;
  installations: InstallationRegistry;
  credentials: UpstreamCredentialProvider;
  uris?: UriMapper;
  clock?: Clock;
  logger?: Logger;
  graceMs?: number;
  tickMs?: number;
};

const keyOf = (args: ListenArgs): string =>
  `${args.installation.installationId}:${args.credential.credentialHash}`;

export class ListenManager {
  private readonly interests = new Map<string, { count: number; args: ListenArgs }>();
  private readonly held = new Map<string, Held>();
  private readonly owned = new Map<string, Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly uris: UriMapper;
  private readonly graceMs: number;

  constructor(private readonly deps: ListenManagerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.uris = deps.uris ?? identityUriMapper;
    this.graceMs = deps.graceMs ?? LISTEN_CLOSE_GRACE_MS;
  }

  /** Subscribes to every new session's notifications and serves the `subscriptions` RPC route. */
  attach(): void {
    this.deps.service.onSession((info) => this.watch(info));
    this.deps.service.subscriptionHandler = (instanceId, body) => this.handleRpc(instanceId, body);
  }

  // --- notifications ---------------------------------------------------------------------------------------------------

  private watch(info: SessionInfo): void {
    info.session.onNotification((n) => void this.onNotification(info, n));
  }

  /** An upstream notification: invalidate and publish (6.6). */
  async onNotification(info: SessionInfo, notification: UpstreamNotification): Promise<void> {
    const kind = NOTIFICATION_KIND[notification.method];
    if (kind) {
      await this.deps.lists.invalidate(info.installation.installationId, info.credentialHash);
      await this.deps.publisher.listChanged(info.installation, [kind], info.principalId);
      return;
    }
    if (notification.method === 'notifications/resources/updated') {
      const uri =
        typeof notification.params?.uri === 'string' ? notification.params.uri : undefined;
      if (uri === undefined) return;
      for (const downstream of this.uris.toDownstream(info.installation.installationId, uri)) {
        await this.deps.publisher.resourceUpdated(info.installation, downstream, info.principalId);
      }
    }
  }

  // --- reference counting and the ulisten lease (modern remotes) --------------------------------------------------------

  /** A downstream subscriber appeared for this installation and credential (a `subscriptions/listen` stream). */
  async join(args: ListenArgs): Promise<number> {
    const key = keyOf(args);
    const interest = this.interests.get(key) ?? { count: 0, args };
    interest.count += 1;
    this.interests.set(key, interest);
    const count = await this.deps.redis.incr(
      redisKeys.listenRefs(args.installation.installationId, args.credential.credentialHash),
    );
    this.start();
    await this.tick();
    return count;
  }

  /** The subscriber left. The listen stays open for `graceMs` after the last one (60 s). */
  async leave(args: ListenArgs): Promise<number> {
    const key = keyOf(args);
    const interest = this.interests.get(key);
    if (interest) {
      interest.count -= 1;
      if (interest.count <= 0) this.interests.delete(key);
    }
    const count = Number(
      await this.deps.redis.eval(
        DECR_FLOOR,
        1,
        redisKeys.listenRefs(args.installation.installationId, args.credential.credentialHash),
      ),
    );
    return count;
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? LISTEN_TICK_MS);
    this.timer.unref?.();
  }

  /** One pass: renew held leases, take vacant ones that have subscribers, close listens nobody needs (6.6, 21.2). */
  async tick(): Promise<void> {
    const keys = new Set([...this.interests.keys(), ...this.held.keys()]);
    for (const key of keys) {
      try {
        await this.tickKey(key);
      } catch (error) {
        this.logger.warn('listen tick failed', { key, error: String(error) });
      }
    }
    if (this.interests.size === 0 && this.held.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async refsOf(args: ListenArgs): Promise<number> {
    const raw = await this.deps.redis.get(
      redisKeys.listenRefs(args.installation.installationId, args.credential.credentialHash),
    );
    return raw === null ? 0 : Number(raw);
  }

  private async tickKey(key: string): Promise<void> {
    const me = this.deps.registry.workerId;
    const held = this.held.get(key);
    const args = held?.args ?? this.interests.get(key)?.args;
    if (!args) return;
    const leaseKey = redisKeys.listenLease(
      args.installation.installationId,
      args.credential.credentialHash,
    );
    if (held) {
      const renewed = await this.deps.redis.eval(
        COMPARE_AND_PEXPIRE,
        1,
        leaseKey,
        me,
        LEASE_TTL_MS,
      );
      if (renewed !== 1 && renewed !== '1') {
        await this.closeHeld(key, false); // lost the lease: another worker listens now (21.2)
        return;
      }
      const refs = await this.refsOf(args);
      if (refs <= 0) {
        held.zeroSince ??= this.clock.now();
        if (this.clock.now() - held.zeroSince >= this.graceMs) await this.closeHeld(key, true);
      } else {
        held.zeroSince = undefined;
      }
      return;
    }
    // Not holding: take the lease when it is vacant or its holder is gone, and there are subscribers.
    if ((await this.refsOf(args)) <= 0 && !this.interests.has(key)) return;
    const holder = await this.deps.redis.get(leaseKey);
    if (holder !== null) {
      if (holder === me) return;
      if (await this.deps.registry.lookup(holder)) return;
      await this.deps.redis.eval(COMPARE_AND_DELETE, 1, leaseKey, holder);
    }
    const got = await this.deps.redis.set(leaseKey, me, 'PX', LEASE_TTL_MS, 'NX');
    if (got === null) return;
    const entry: Held = { args, uris: new Map() };
    this.held.set(key, entry);
    try {
      await this.open(entry);
    } catch (error) {
      this.logger.warn('could not open the upstream listen stream', { key, error: String(error) });
      await this.closeHeld(key, true);
    }
  }

  private filterOf(entry: Held) {
    return {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      ...(entry.uris.size > 0 ? { resourceSubscriptions: [...entry.uris.keys()].sort() } : {}),
    };
  }

  private async open(entry: Held): Promise<void> {
    const { installation, principal, credential } = entry.args;
    const session = await this.deps.service.pooledSession(
      installation,
      principal,
      credential,
      AbortSignal.timeout(UPSTREAM_TIMEOUTS_MS.subscriptionRequest),
    );
    if (!session) {
      // Owned (legacy or sandbox) upstreams deliver notifications on their own stream: nothing to open.
      return;
    }
    const filter = this.filterOf(entry);
    const signature = JSON.stringify(filter);
    if (entry.subscription && entry.openedFilter === signature) return;
    const previous = entry.subscription;
    const ctx = this.contextFor(entry.args);
    entry.subscription = await session.listen(filter, { ctx });
    entry.openedFilter = signature;
    if (previous) await previous.close().catch(() => undefined);
    void entry.subscription.closed.then((how) => {
      if (how === 'remote' && this.held.get(keyOf(entry.args)) === entry)
        entry.subscription = undefined;
    });
  }

  private contextFor(args: ListenArgs): UpstreamCallContext {
    return {
      principal: args.principal,
      installationId: args.installation.installationId,
      era: 'modern',
      clientCapabilities: {},
      trace: {},
    };
  }

  private async closeHeld(key: string, release: boolean): Promise<void> {
    const entry = this.held.get(key);
    if (!entry) return;
    this.held.delete(key);
    await entry.subscription?.close().catch(() => undefined);
    if (release) {
      const { installation, credential } = entry.args;
      await this.deps.redis
        .eval(
          COMPARE_AND_DELETE,
          1,
          redisKeys.listenLease(installation.installationId, credential.credentialHash),
          this.deps.registry.workerId,
        )
        .catch(() => 0);
    }
  }

  isHolding(args: ListenArgs): boolean {
    return this.held.has(keyOf(args));
  }

  openListens(): number {
    return [...this.held.values()].filter((h) => h.subscription !== undefined).length;
  }

  // --- resource subscriptions ---------------------------------------------------------------------------------------------

  /**
   * Registers a downstream subscription to a URI upstream: on the owner (sandboxes, legacy remotes) or on the `ulisten`
   * holder (modern remotes). The URI is routed through the URI index (7.4).
   */
  async subscribeResource(
    args: ListenArgs & { downstreamUri: string; endpointId?: string },
    signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUTS_MS.subscriptionRequest),
  ): Promise<void> {
    await this.changeSubscription('add', args, signal);
  }

  async unsubscribeResource(
    args: ListenArgs & { downstreamUri: string; endpointId?: string },
    signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUTS_MS.subscriptionRequest),
  ): Promise<void> {
    await this.changeSubscription('remove', args, signal);
  }

  private async changeSubscription(
    action: 'add' | 'remove',
    args: ListenArgs & { downstreamUri: string; endpointId?: string },
    signal: AbortSignal,
  ): Promise<void> {
    const { installation, principal, credential } = args;
    const upstreamUri = this.uris.toUpstream(installation.installationId, args.downstreamUri);
    const ctx = this.contextFor(args);
    const body: SubscriptionBody = {
      action,
      kind: 'resource',
      uri: upstreamUri,
      principalId: principal.userId,
      ...(args.endpointId === undefined ? {} : { endpointId: args.endpointId }),
      ctx: toWireContext(ctx),
    };
    const pooled = await this.deps.service.pooledSession(
      installation,
      principal,
      credential,
      signal,
    );
    if (pooled) {
      // Modern remote: the ulisten holder keeps one stream whose filter lists every subscribed URI.
      const key = keyOf(args);
      const leaseKey = redisKeys.listenLease(
        installation.installationId,
        credential.credentialHash,
      );
      if (action === 'add') await this.join(args);
      let holder = await this.deps.redis.get(leaseKey);
      if (holder === null) {
        await this.tick();
        holder = await this.deps.redis.get(leaseKey);
      }
      if (holder === this.deps.registry.workerId || this.held.has(key)) {
        await this.applyHolder(key, upstreamUri, action);
        return;
      }
      const worker = holder ? await this.deps.registry.lookup(holder) : null;
      if (!worker) throw new Error('no worker holds the upstream listen stream');
      await this.deps.rpc.forwardSubscription(worker.address, key, body, signal);
      return;
    }
    // Owned upstream: the owner registers it upstream.
    const target = await this.deps.service.acquireOwned(
      installation,
      principal,
      credential,
      signal,
    );
    if (target.kind === 'local') {
      await this.applyOwner(target.instanceId, target.live, upstreamUri, action, ctx);
      return;
    }
    await this.deps.rpc.forwardSubscription(target.address, target.instanceId, body, signal);
  }

  private async applyHolder(key: string, uri: string, action: 'add' | 'remove'): Promise<void> {
    const entry = this.held.get(key);
    if (!entry) return;
    const count = (entry.uris.get(uri) ?? 0) + (action === 'add' ? 1 : -1);
    if (count <= 0) entry.uris.delete(uri);
    else entry.uris.set(uri, count);
    await this.open(entry);
  }

  private async applyOwner(
    instanceId: string,
    live: {
      session: {
        subscribe(uri: string, o: { ctx: UpstreamCallContext }): Promise<void>;
        unsubscribe(uri: string, o: { ctx: UpstreamCallContext }): Promise<void>;
      };
    },
    uri: string,
    action: 'add' | 'remove',
    ctx: UpstreamCallContext,
  ): Promise<void> {
    const counts = this.owned.get(instanceId) ?? new Map<string, number>();
    this.owned.set(instanceId, counts);
    const before = counts.get(uri) ?? 0;
    const after = Math.max(0, before + (action === 'add' ? 1 : -1));
    if (after === 0) counts.delete(uri);
    else counts.set(uri, after);
    if (action === 'add' && before === 0) await live.session.subscribe(uri, { ctx });
    if (action === 'remove' && after === 0 && before > 0)
      await live.session.unsubscribe(uri, { ctx });
  }

  /** `POST /internal/v1/instances/{id}/subscriptions` on this worker (21.2). */
  async handleRpc(id: string, body: SubscriptionBody): Promise<void> {
    if (body.kind !== 'resource' || body.uri === undefined) return;
    const installation = await this.deps.installations.get(body.ctx.installationId);
    if (!installation) throw new Error('unknown installation');
    const principal = body.ctx.principal;
    const credential = await this.deps.credentials.resolve(
      principal,
      installation,
      installation.spec,
    );
    const ctx = { ...body.ctx, principal } as UpstreamCallContext;
    if (id.includes(':')) {
      // `installationId:credentialHash`: the modern remote listen holder.
      const entry = this.held.get(id);
      if (!entry) throw new Error('this worker does not hold the listen stream');
      await this.applyHolder(id, body.uri, body.action);
      return;
    }
    const target = await this.deps.service.acquireOwned(
      installation,
      principal,
      credential,
      AbortSignal.timeout(UPSTREAM_TIMEOUTS_MS.subscriptionRequest),
    );
    if (target.kind !== 'local') throw new Error('the instance moved to another worker; retry');
    await this.applyOwner(target.instanceId, target.live, body.uri, body.action, ctx);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const key of [...this.held.keys()]) await this.closeHeld(key, true);
    this.interests.clear();
  }
}
