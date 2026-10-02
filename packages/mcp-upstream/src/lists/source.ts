import { BastionError, MAX_LIST_ITEMS_PER_INSTALLATION, TIMEOUTS_MS } from '@bastion-mcp/core';
import {
  chooseListSource,
  diffSnapshots,
  type InstallationInfo,
  type Operation,
  type OpOutcome,
  type ProviderContext,
  type UpstreamCaller,
  type UpstreamItemSource,
  type UpstreamItems,
  type UpstreamListResult,
} from '@bastion-mcp/router';
import {
  AuthRequiredError,
  type CallPrincipal,
  type Clock,
  type InstallationRegistry,
  type ListChangedPublisher,
  type ListKind,
  type Logger,
  noopLogger,
  type PinChecker,
  type ResolvedCredential,
  type ResolvedInstallation,
  type SnapshotItems,
  type SnapshotStore,
  systemClock,
  type UpstreamCredentialProvider,
} from '../ports';
import type { SessionInfo, UpstreamService } from '../service/service';
import type { JsonObject, UpstreamCallContext, UpstreamOutcome } from '../types';
import { type CachedList, LIST_METHODS, ListCache, type ListMethod, ReadCache } from './cache';

/**
 * Upstream lists (6.7, 7.5): implements the router's `UpstreamItemSource` and `UpstreamCaller`. Lists are cached per
 * `(installationId, credentialHash)`, snapshots serve lists of instances that are not running (so listing never
 * starts a sandbox when a snapshot exists), and a first list with no snapshot starts the instance and waits up to
 * 20 s before reporting the installation degraded.
 */

const MAX_PAGES = 1_000;
/** A live list younger than this makes the post-start re-list redundant. */
const RECENT_LIST_MS = 5_000;

const KEY_OF: Record<
  ListMethod,
  keyof Pick<UpstreamItems, 'tools' | 'prompts' | 'resources' | 'resourceTemplates'>
> = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
};
const RESULT_KEY: Record<ListMethod, string> = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
};

export type ListsDeps = {
  service: UpstreamService;
  redis: ConstructorParameters<typeof ListCache>[0]['redis'];
  installations: InstallationRegistry;
  credentials: UpstreamCredentialProvider;
  snapshots: SnapshotStore;
  changed?: ListChangedPublisher | undefined;
  pins?: PinChecker | undefined;
  /** `BASTION_LIST_CACHE_TTL_MS` */
  listCacheTtlMs?: number | undefined;
  /** Context defaults for the router's `UpstreamCaller`, which carries no client capabilities. */
  callContext?: (
    installation: InstallationInfo,
    ctx: ProviderContext,
  ) => Partial<UpstreamCallContext>;
  clock?: Clock;
  logger?: Logger;
  /** How long a first list waits for a cold start (20 s, 7.5). */
  startWaitMs?: number;
};

export type PagedResult = { items: unknown[]; truncated: boolean; ttlMs?: number | undefined };

/** Reads every page of an upstream list, up to 10,000 items (7.5). */
export const readAllPages = async (
  fetchPage: (cursor: string | undefined) => Promise<JsonObject>,
  resultKey: string,
  cap = MAX_LIST_ITEMS_PER_INSTALLATION,
): Promise<PagedResult> => {
  const items: unknown[] = [];
  let cursor: string | undefined;
  let ttlMs: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    const batch = Array.isArray(result[resultKey]) ? (result[resultKey] as unknown[]) : [];
    if (typeof result.ttlMs === 'number') {
      ttlMs = ttlMs === undefined ? result.ttlMs : Math.min(ttlMs, result.ttlMs);
    }
    items.push(...batch);
    if (items.length >= cap)
      return {
        items: items.slice(0, cap),
        truncated: items.length > cap || typeof result.nextCursor === 'string',
        ttlMs,
      };
    cursor =
      typeof result.nextCursor === 'string' && result.nextCursor !== ''
        ? result.nextCursor
        : undefined;
    if (cursor === undefined) return { items, truncated: false, ttlMs };
  }
  return { items, truncated: true, ttlMs };
};

const degradedCode = (error: unknown): string => {
  if (error instanceof AuthRequiredError) return 'auth_required';
  if (error instanceof BastionError) return error.code.toLowerCase();
  return 'list_failed';
};

const MAX_DETAIL = 500;

/**
 * Why a listing degraded, for the person fixing it (the catalog TEST, the installation page). Only errors Bastion
 * raised on purpose carry a message written for people; anything else stays out of API responses (6.9).
 */
export const degradedFrom = (
  error: unknown,
): { status: 'degraded'; code: string; detail?: string } => {
  const code = degradedCode(error);
  return error instanceof BastionError && error.message
    ? { status: 'degraded', code, detail: error.message.slice(0, MAX_DETAIL) }
    : { status: 'degraded', code };
};

const toItems = (snapshot: SnapshotItems): UpstreamItems => ({
  tools: snapshot.tools as UpstreamItems['tools'],
  prompts: snapshot.prompts as UpstreamItems['prompts'],
  resources: snapshot.resources as UpstreamItems['resources'],
  resourceTemplates: snapshot.resourceTemplates as UpstreamItems['resourceTemplates'],
  instructions: snapshot.instructions,
  serverInfo: snapshot.serverInfo,
  ttlMs: snapshot.ttlMs,
});

export class UpstreamLists implements UpstreamItemSource, UpstreamCaller {
  readonly cache: ListCache;
  readonly reads: ReadCache;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly inflight = new Map<string, Promise<UpstreamListResult>>();
  private readonly refreshing = new Set<string>();
  private readonly listing = new Set<string>();
  private readonly lastLive = new Map<string, number>();

  constructor(private readonly deps: ListsDeps) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.cache = new ListCache({
      redis: deps.redis,
      ...(deps.listCacheTtlMs === undefined ? {} : { defaultTtlMs: deps.listCacheTtlMs }),
      clock: this.clock,
      logger: this.logger,
    });
    this.reads = new ReadCache(deps.redis, { clock: this.clock });
  }

  /**
   * Wires "when the instance next starts, Bastion re-lists, updates the snapshot and emits `list_changed` if anything
   * differs" (7.5): every new upstream session triggers a background refresh.
   */
  attach(): void {
    this.deps.service.onSession((info) => void this.refreshAfterStart(info));
  }

  private async refreshAfterStart(info: SessionInfo): Promise<void> {
    const key = `${info.installation.installationId}:${info.credentialHash}`;
    // A list that is running now (or just ran) already read the fresh upstream: nothing to re-list.
    if (this.refreshing.has(key) || this.listing.has(key)) return;
    if (this.clock.now() - (this.lastLive.get(key) ?? 0) < RECENT_LIST_MS) return;
    this.refreshing.add(key);
    try {
      await this.cache.invalidate(info.installation.installationId, info.credentialHash);
      const credential: ResolvedCredential = {
        injections: [],
        credentialHash: info.credentialHash,
      };
      await this.listLive(info.installation, { userId: info.principalId }, credential, {
        notify: true,
      });
    } catch (error) {
      this.logger.debug('post-start re-list failed', { error: String(error) });
    } finally {
      this.refreshing.delete(key);
    }
  }

  // --- UpstreamItemSource ---------------------------------------------------------------------------------------------

  async listItems(info: InstallationInfo, ctx: ProviderContext): Promise<UpstreamListResult> {
    const installation = await this.deps.installations.get(info.id);
    if (!installation) return { status: 'degraded', code: 'installation_missing' };
    const principal: CallPrincipal = { userId: ctx.principalId };
    let credential: ResolvedCredential;
    try {
      credential = await this.deps.credentials.resolve(principal, installation, installation.spec);
    } catch (error) {
      return degradedFrom(error);
    }
    const key = `${installation.installationId}:${credential.credentialHash}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.resolveList(installation, principal, credential)
      .then((result) => this.pinned(installation, result))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Pin drift applies to every origin (cache, snapshot, live), because the caches hold the raw upstream lists (13.6). */
  private async pinned(
    installation: ResolvedInstallation,
    result: UpstreamListResult,
  ): Promise<UpstreamListResult> {
    if (result.status !== 'ok') return result;
    try {
      return { ...result, items: await this.applyPins(installation, result.items) };
    } catch (error) {
      return degradedFrom(error);
    }
  }

  private async resolveList(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
  ): Promise<UpstreamListResult> {
    const cached = await this.readCached(installation, credential.credentialHash);
    const [snapshot, reference] = cached
      ? [null, null]
      : await Promise.all([
          this.deps.snapshots.get(installation.installationId, installation.configHash),
          this.deps.snapshots.getReference(installation.catalogVersionId, installation.configHash),
        ]);
    const running = await this.isRunning(installation);
    const choice = chooseListSource({
      cache: cached !== null,
      instanceRunning: running,
      snapshot: snapshot !== null,
      referenceSnapshot: reference !== null,
    });
    try {
      switch (choice.source) {
        case 'cache':
          return { status: 'ok', items: cached as UpstreamItems, origin: 'cache' };
        case 'snapshot':
          return { status: 'ok', items: toItems(snapshot as SnapshotItems), origin: 'snapshot' };
        case 'reference':
          return { status: 'ok', items: toItems(reference as SnapshotItems), origin: 'reference' };
        case 'live': {
          try {
            return {
              status: 'ok',
              items: await this.listLive(installation, principal, credential, { notify: false }),
              origin: 'live',
            };
          } catch (error) {
            // A running instance that cannot list: serve the last snapshot rather than nothing (7.5).
            const fallback = await this.deps.snapshots.get(
              installation.installationId,
              installation.configHash,
            );
            if (fallback) return { status: 'ok', items: toItems(fallback), origin: 'snapshot' };
            throw error;
          }
        }
        case 'start':
          return await this.startAndList(installation, principal, credential, choice.waitMs);
      }
    } catch (error) {
      this.logger.warn('listing an installation failed', {
        installation: installation.slug,
        error: String(error),
      });
      return degradedFrom(error);
    }
  }

  /** No snapshot at all: the list starts the instance and waits up to 20 s, else the installation is degraded (7.5). */
  private async startAndList(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    waitMs: number,
  ): Promise<UpstreamListResult> {
    const work = this.listLive(installation, principal, credential, { notify: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.deps.startWaitMs ?? waitMs);
    });
    try {
      const winner = await Promise.race([work, timeout]);
      if (winner === 'timeout') {
        // The start continues; `list_changed` follows when the instance is ready (7.5).
        void work
          .then(() =>
            this.deps.changed?.listChanged(
              installation,
              ['tools', 'prompts', 'resources'],
              principal.userId,
            ),
          )
          .catch(() => undefined);
        return { status: 'degraded', code: 'starting' };
      }
      return { status: 'ok', items: winner, origin: 'started' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async isRunning(installation: ResolvedInstallation): Promise<boolean> {
    // Remote upstreams cost nothing to reach; only sandboxes have a "not running" state (8.6).
    if (installation.spec.type === 'remote') return true;
    const located = await this.deps.service.locateInstance(installation);
    return located.owner !== 'none';
  }

  private async readCached(
    installation: ResolvedInstallation,
    credentialHash: string,
  ): Promise<UpstreamItems | null> {
    const entries = await Promise.all(
      LIST_METHODS.map(
        async (method) =>
          [
            method,
            await this.cache.get(installation.installationId, credentialHash, method),
          ] as const,
      ),
    );
    // Caching is all-or-nothing per installation: any missing method means a live read.
    if (entries.some(([, value]) => value === null)) return null;
    const first = entries[0]?.[1];
    return this.assemble(
      entries.map(([method, value]) => [method, value as CachedList]),
      first?.instructions,
      first?.serverInfo,
    );
  }

  private assemble(
    entries: ReadonlyArray<readonly [ListMethod, CachedList]>,
    instructions: string | undefined,
    serverInfo: CachedList['serverInfo'],
  ): UpstreamItems {
    const items: UpstreamItems = { tools: [], prompts: [], resources: [], resourceTemplates: [] };
    let ttl: number | undefined;
    for (const [method, value] of entries) {
      (items[KEY_OF[method]] as unknown[]) = value.items;
      if (value.ttlMs !== undefined)
        ttl = ttl === undefined ? value.ttlMs : Math.min(ttl, value.ttlMs);
    }
    items.instructions = instructions;
    items.serverInfo = serverInfo
      ? {
          name: serverInfo.name,
          version: serverInfo.version,
          ...(serverInfo.title === undefined ? {} : { title: serverInfo.title }),
        }
      : undefined;
    items.ttlMs = ttl;
    return items;
  }

  // --- live listing --------------------------------------------------------------------------------------------------------

  private listContext(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
  ): UpstreamCallContext {
    return {
      principal,
      installationId: installation.installationId,
      era: 'modern',
      clientCapabilities: {},
      trace: {},
      deadlineAt: this.clock.now() + TIMEOUTS_MS.maxOverride,
    };
  }

  /**
   * Reads every page of every list the upstream supports, fills both cache layers, writes the snapshot and, when
   * anything differs from the previous snapshot, emits `list_changed` (7.5, 6.7).
   */
  async listLive(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    options: { notify: boolean },
  ): Promise<UpstreamItems> {
    const liveKey = `${installation.installationId}:${credential.credentialHash}`;
    this.listing.add(liveKey);
    try {
      return await this.listLiveUncached(installation, principal, credential, options);
    } finally {
      this.listing.delete(liveKey);
      this.lastLive.set(liveKey, this.clock.now());
    }
  }

  private async listLiveUncached(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    options: { notify: boolean },
  ): Promise<UpstreamItems> {
    const ctx = this.listContext(installation, principal);
    const read = async (method: ListMethod): Promise<PagedResult | undefined> => {
      try {
        return await readAllPages(async (cursor) => {
          const outcome = await this.deps.service.execute({
            installationId: installation.installationId,
            method,
            params: cursor === undefined ? {} : { cursor },
            ctx,
          });
          if (outcome.kind !== 'complete') throw new Error(`${method} cannot need input`);
          return outcome.result as JsonObject;
        }, RESULT_KEY[method]);
      } catch (error) {
        // An upstream that does not implement a list (-32601) simply has none of that kind.
        if (error instanceof BastionError && error.mcpCode === -32601) return undefined;
        throw error;
      }
    };
    // Tools first: a failure there fails the listing, like an unreachable upstream (7.5).
    const tools = await read('tools/list');
    const [prompts, resources, templates] = await Promise.all([
      read('prompts/list'),
      read('resources/list'),
      read('resources/templates/list'),
    ]);
    const meta = await this.deps.service.upstreamMeta(installation, principal, credential);
    const items: UpstreamItems = {
      tools: (tools?.items ?? []) as UpstreamItems['tools'],
      prompts: (prompts?.items ?? []) as UpstreamItems['prompts'],
      resources: (resources?.items ?? []) as UpstreamItems['resources'],
      resourceTemplates: (templates?.items ?? []) as UpstreamItems['resourceTemplates'],
      instructions: meta.instructions,
      serverInfo: meta.serverInfo,
      ttlMs: minTtl([tools, prompts, resources, templates]),
    };
    for (const [method, paged] of [
      ['tools/list', tools],
      ['prompts/list', prompts],
      ['resources/list', resources],
      ['resources/templates/list', templates],
    ] as const) {
      await this.cache.put(installation.installationId, credential.credentialHash, method, {
        items: paged?.items ?? [],
        ttlMs: paged?.ttlMs,
        instructions: items.instructions,
        serverInfo: items.serverInfo,
      });
    }
    await this.storeSnapshot(installation, items, principal.userId, options.notify);
    return items;
  }

  /** Definition pin drift (13.6): the guards package decides through the `PinChecker` port. */
  private async applyPins(
    installation: ResolvedInstallation,
    items: UpstreamItems,
  ): Promise<UpstreamItems> {
    if (!this.deps.pins) return items;
    const verdict = await this.deps.pins.check(installation.installationId, items.tools);
    if (verdict.ok) return items;
    if (verdict.action === 'block') {
      throw new BastionError(
        'PIN_DRIFT_BLOCKED',
        'tool definitions changed and the installation is blocked',
        {
          httpStatus: 403,
        },
      );
    }
    if (verdict.action === 'hideChanged') {
      const hidden = new Set(verdict.changed);
      return {
        ...items,
        tools: items.tools.filter((tool) => !hidden.has((tool as { name: string }).name)),
      };
    }
    this.logger.warn('tool definitions drifted from their pins', {
      installation: installation.slug,
      changed: verdict.changed,
    });
    return items;
  }

  private async storeSnapshot(
    installation: ResolvedInstallation,
    items: UpstreamItems,
    principalId: string,
    notify: boolean,
  ): Promise<void> {
    try {
      const previous = await this.deps.snapshots.get(
        installation.installationId,
        installation.configHash,
      );
      await this.deps.snapshots.put(installation.installationId, installation.configHash, {
        tools: items.tools,
        prompts: items.prompts,
        resources: items.resources,
        resourceTemplates: items.resourceTemplates,
        instructions: items.instructions,
        serverInfo: items.serverInfo,
        ttlMs: items.ttlMs,
      });
      if (!notify || !previous) return;
      const diff = diffSnapshots(toItems(previous), items);
      if (!diff.changed) return;
      const kinds: ListKind[] = [];
      if (diff.tool) kinds.push('tools');
      if (diff.prompt) kinds.push('prompts');
      if (diff.resource || diff.resourceTemplate) kinds.push('resources');
      await this.deps.changed?.listChanged(installation, kinds, principalId);
    } catch (error) {
      this.logger.warn('could not store the list snapshot', { error: String(error) });
    }
  }

  /** Upstream `list_changed`: delete both cache layers for that credential (6.6, 6.7). */
  invalidate(installationId: string, credentialHash?: string): Promise<void> {
    return this.cache.invalidate(installationId, credentialHash);
  }

  // --- UpstreamCaller ----------------------------------------------------------------------------------------------------

  async call(info: InstallationInfo, op: Operation, ctx: ProviderContext): Promise<OpOutcome> {
    const principal: CallPrincipal = { userId: ctx.principalId };
    const base: UpstreamCallContext = {
      principal,
      installationId: info.id,
      era: 'modern',
      clientCapabilities: {},
      trace: {},
      endpointId: ctx.endpointId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(this.deps.callContext?.(info, ctx) ?? {}),
    };
    const { method, params } = toRequest(op);
    if (method === 'resources/read' && op.uri !== undefined) {
      const cached = await this.reads.get(info.id, op.uri);
      if (cached !== undefined) return { result: cached };
    }
    const outcome = await this.deps.service.execute({
      installationId: info.id,
      method,
      params,
      ctx: base,
    });
    if (method === 'resources/read' && op.uri !== undefined && outcome.kind === 'complete') {
      await this.reads.put(info.id, op.uri, outcome.result);
    }
    return { result: outcomeResult(outcome) };
  }
}

const minTtl = (parts: ReadonlyArray<PagedResult | undefined>): number | undefined => {
  const values = parts.flatMap((p) => (p?.ttlMs === undefined ? [] : [p.ttlMs]));
  return values.length === 0 ? undefined : Math.min(...values);
};

const toRequest = (op: Operation): { method: string; params: JsonObject } => {
  switch (op.method) {
    case 'tools/call':
      return { method: op.method, params: { name: op.name, arguments: op.arguments ?? {} } };
    case 'prompts/get':
      return { method: op.method, params: { name: op.name, arguments: op.arguments ?? {} } };
    case 'resources/read':
      return { method: op.method, params: { uri: op.uri } };
    case 'completion/complete':
      // `arguments` carries the complete `completion/complete` params (ref, argument, context).
      return { method: op.method, params: { ...(op.arguments ?? {}) } };
  }
};

/** The router's `OpOutcome` has one `result`: an MRTR `input_required` or a task travels in that shape (6.2). */
const outcomeResult = (outcome: UpstreamOutcome): unknown => {
  switch (outcome.kind) {
    case 'complete':
      return outcome.result;
    case 'task':
      return outcome.task;
    case 'input_required':
      return {
        resultType: 'input_required',
        ...(outcome.inputRequests ? { inputRequests: outcome.inputRequests } : {}),
        requestState: outcome.requestState,
      };
  }
};
