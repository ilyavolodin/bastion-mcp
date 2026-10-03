/**
 * How the ui-side code (catalog TEST flow, effective-endpoint preview, "restart", "try") reaches upstream servers.
 *
 * Only workers touch MCP traffic and sandboxes (4.1). Two implementations:
 *
 * - `workerAccess`: the process hosts a worker (`BASTION_ROLE=all`, or tests): it uses `runtime.lists` and
 *   `runtime.instances` in-process.
 * - `createUiWorkerClient`: a `ui`-only process goes through the public gateway endpoints as the user (see
 *   `gateway-client.ts` for why the internal RPC cannot do this), so workers run the call exactly as for any client.
 */

import { BastionError, META_KEYS, type PackageSpec, redisKeys } from '@bastion-mcp/core';
import type { InstallationInfo, UpstreamItems, UpstreamListResult } from '@bastion-mcp/router';
import type { Client } from '@modelcontextprotocol/client';
import type { AuthServices, WorkerServices } from '../contracts';
import type { Infra } from '../infra';
import { pollUntil } from '../poll';
import { MAX_ERROR_CODE_CHARS, UPSTREAM_LIST_POLL_MS, UPSTREAM_LIST_TIMEOUT_MS } from '../timing';
import { connectAsPrincipal, effectiveSlugOf } from './gateway-client';

export type ListOutcome =
  | { status: 'ok'; items: UpstreamItems }
  | { status: 'degraded'; code: string; detail?: string };

export interface UpstreamAccess {
  /** The normal (cached) listing the endpoint compiler uses. */
  listItems(
    installationId: string,
    principalId: string,
    signal?: AbortSignal,
  ): Promise<ListOutcome>;
  /** A live listing that bypasses list caches and snapshots, waiting while a cold start runs (11.3 test). */
  listFresh(
    installationId: string,
    principalId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ListOutcome>;
  /**
   * The one-off lockfile capture of 8.7 in a throwaway sandbox. Absent where this process cannot run sandboxes
   * (a `ui`-only process); the TEST flow then skips the step.
   */
  captureLockfile?(
    spec: PackageSpec,
    context: { userId: string; label: string; signal?: AbortSignal },
  ): Promise<{ kind: 'npm-shrinkwrap' | 'uv-requirements'; content: string; sha256: string }>;
  /** Stops the installation's instance so the next call starts a new one (8.6). */
  restart(installationId: string): Promise<void>;
  /** Stops the installation's instance and frees its lease, before the installation is deleted. */
  stop(installationId: string): Promise<void>;
  /** The era verdict recorded for the installation (6.4). */
  era(installationId: string): Promise<'modern' | 'legacy' | undefined>;
}

const scanKeys = async (infra: Infra, pattern: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await infra.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
};

/** `era:{installationId}:{credentialHash}` records `{kind: 'modern' | 'legacy'}`; the newest hit wins. */
const readEra = async (infra: Infra, installationId: string) => {
  const keys = await scanKeys(infra, redisKeys.era(installationId, '*'));
  for (const key of keys) {
    const raw = await infra.redis.get(key);
    if (!raw) continue;
    try {
      const kind = (JSON.parse(raw) as { kind?: unknown }).kind;
      if (kind === 'modern' || kind === 'legacy') return kind;
    } catch {
      // ignore unreadable entries
    }
  }
  return undefined;
};

const dropListCaches = async (infra: Infra, installationId: string): Promise<void> => {
  const keys = await scanKeys(infra, `lc:${installationId}:*`);
  if (keys.length > 0) await infra.redis.del(...keys);
  await infra.db.prisma.upstreamSnapshot.deleteMany({ where: { installationId } });
};

const COLD_START_CODES = new Set(['starting']);

export const workerAccess = (infra: Infra, worker: WorkerServices): UpstreamAccess => {
  const listItems = async (
    installationId: string,
    principalId: string,
    signal?: AbortSignal,
  ): Promise<ListOutcome> => {
    const out: UpstreamListResult = await worker.runtime.lists.listItems(
      { id: installationId } as InstallationInfo,
      { principalId, endpointId: `installation:${installationId}`, signal },
    );
    return out.status === 'ok' ? { status: 'ok', items: out.items } : out;
  };
  return {
    listItems,
    async listFresh(installationId, principalId, options = {}) {
      await dropListCaches(infra, installationId);
      return pollUntil(
        () => listItems(installationId, principalId, options.signal),
        (out) => out.status === 'ok' || !COLD_START_CODES.has(out.code),
        {
          timeoutMs: options.timeoutMs ?? UPSTREAM_LIST_TIMEOUT_MS,
          intervalMs: UPSTREAM_LIST_POLL_MS,
          clock: infra.clock,
        },
      );
    },
    captureLockfile: (spec, context) => worker.runtime.instances.captureLockfile(spec, context),
    async restart(installationId) {
      const record = await infra.repos.instances.getForInstallation(installationId);
      if (!record) return;
      await worker.runtime.instances.restart(record.id).catch(() => undefined);
      await worker.runtime.instances.stopAnywhere(record.id).catch(() => undefined);
    },
    async stop(installationId) {
      const record = await infra.repos.instances.getForInstallation(installationId);
      if (!record) return;
      await worker.runtime.instances.stopAnywhere(record.id).catch(() => undefined);
      await infra.redis.del(redisKeys.lease(record.id)).catch(() => undefined);
    },
    era: (installationId) => readEra(infra, installationId),
  };
};

const RETRY = Symbol('retry');

type ListPage = {
  _meta?: Record<string, unknown> | undefined;
  nextCursor?: string | undefined;
} & Record<string, unknown>;
type ListParams = { cursor?: string };

const LIST_CALLS: readonly [
  keyof Omit<UpstreamItems, 'instructions' | 'serverInfo' | 'ttlMs'>,
  (client: Client, params: ListParams) => Promise<ListPage>,
][] = [
  ['tools', (client, params) => client.listTools(params)],
  ['prompts', (client, params) => client.listPrompts(params)],
  ['resources', (client, params) => client.listResources(params)],
  ['resourceTemplates', (client, params) => client.listResourceTemplates(params)],
];

/**
 * `createUiWorkerClient`: the ui-only implementation. It lists through the gateway's own endpoint as the user (see
 * `gateway-client.ts`), enabling a disabled (test) installation for the duration of the call.
 */
export const createUiWorkerClient = (
  infra: Infra,
  auth: Pick<AuthServices, 'keyStore' | 'principalStore'>,
): UpstreamAccess => {
  const withEnabled = async <T>(installationId: string, fn: () => Promise<T>): Promise<T> => {
    const current = await infra.repos.installations.getWithEtag(installationId);
    if (!current || current.installation.enabled) return fn();
    await infra.repos.installations.update(
      installationId,
      { enabled: true },
      { ifMatch: current.etag },
    );
    try {
      return await fn();
    } finally {
      const again = await infra.repos.installations.getWithEtag(installationId);
      if (again) {
        await infra.repos.installations
          .update(installationId, { enabled: false }, { ifMatch: again.etag })
          .catch(() => undefined);
      }
    }
  };

  /** One listing attempt; `RETRY` when the upstream marks its answer degraded (a cold start still running). */
  const listOnce = async (
    principalId: string,
    slug: string,
  ): Promise<ListOutcome | typeof RETRY> => {
    let client: Client | undefined;
    try {
      client = await connectAsPrincipal(infra, auth, principalId, slug);
      const items: UpstreamItems = { tools: [], prompts: [], resources: [], resourceTemplates: [] };
      let degraded = false;
      for (const [key, call] of LIST_CALLS) {
        let cursor: string | undefined;
        do {
          let page: ListPage;
          try {
            page = await call(client, cursor ? { cursor } : {});
          } catch (error) {
            if (key === 'tools') throw error;
            break; // the upstream does not implement this list
          }
          if (page._meta?.[META_KEYS.degraded] !== undefined) degraded = true;
          (items[key] as unknown[]).push(...((page[key] as unknown[] | undefined) ?? []));
          cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        } while (cursor);
      }
      if (degraded) return RETRY;
      const instructions = client.getInstructions();
      return { status: 'ok', items: { ...items, ...(instructions ? { instructions } : {}) } };
    } catch (error) {
      if (error instanceof BastionError) throw error;
      return {
        status: 'degraded',
        code: error instanceof Error ? error.message.slice(0, MAX_ERROR_CODE_CHARS) : 'list_failed',
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
  };

  const list = async (
    installationId: string,
    principalId: string,
    timeoutMs: number,
  ): Promise<ListOutcome> => {
    const slug = await effectiveSlugOf(infra, installationId);
    const out = await pollUntil(
      () => listOnce(principalId, slug),
      (value) => value !== RETRY,
      { timeoutMs, intervalMs: UPSTREAM_LIST_POLL_MS, clock: infra.clock },
    );
    return out === RETRY ? { status: 'degraded', code: 'starting' } : out;
  };

  return {
    listItems: (installationId, principalId) =>
      withEnabled(installationId, () => list(installationId, principalId, 0)),
    async listFresh(installationId, principalId, options = {}) {
      await dropListCaches(infra, installationId);
      return withEnabled(installationId, () =>
        list(installationId, principalId, options.timeoutMs ?? UPSTREAM_LIST_TIMEOUT_MS),
      );
    },
    async restart(installationId) {
      const record = await infra.repos.instances.getForInstallation(installationId);
      if (!record) return;
      await infra.redis.del(redisKeys.lease(record.id));
    },
    async stop(installationId) {
      const record = await infra.repos.instances.getForInstallation(installationId);
      if (record) await infra.redis.del(redisKeys.lease(record.id));
    },
    era: (installationId) => readEra(infra, installationId),
  };
};

/** The access for this process: in-process when a worker runs here, RPC otherwise. */
export const createUpstreamAccess = (
  infra: Infra,
  auth: Pick<AuthServices, 'keyStore' | 'principalStore'>,
  worker?: WorkerServices,
): UpstreamAccess => (worker ? workerAccess(infra, worker) : createUiWorkerClient(infra, auth));
