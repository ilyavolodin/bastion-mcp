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
import type { AuthServices, WorkerServices } from '../contracts';
import type { Infra } from '../infra';
import { connectAsPrincipal, effectiveSlugOf } from './gateway-client';

export type ListOutcome =
  | { status: 'ok'; items: UpstreamItems }
  | { status: 'degraded'; code: string };

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
  /** The era verdict recorded for the installation (6.4). */
  era(installationId: string): Promise<'modern' | 'legacy' | undefined>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      for (;;) {
        const out = await listItems(installationId, principalId, options.signal);
        if (out.status === 'ok' || !COLD_START_CODES.has(out.code) || Date.now() > deadline) {
          return out;
        }
        await sleep(1_000);
      }
    },
    captureLockfile: (spec, context) => worker.runtime.instances.captureLockfile(spec, context),
    async restart(installationId) {
      const record = await infra.repos.instances.getForInstallation(installationId);
      if (!record) return;
      await worker.runtime.instances.restart(record.id).catch(() => undefined);
      await worker.runtime.instances.stopAnywhere(record.id).catch(() => undefined);
    },
    era: (installationId) => readEra(infra, installationId),
  };
};

const LIST_CALLS = [
  ['tools', 'listTools'],
  ['prompts', 'listPrompts'],
  ['resources', 'listResources'],
  ['resourceTemplates', 'listResourceTemplates'],
] as const;

type Listable = Record<string, (params?: { cursor?: string }) => Promise<Record<string, unknown>>>;

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

  const list = async (
    installationId: string,
    principalId: string,
    timeoutMs: number,
  ): Promise<ListOutcome> => {
    const slug = await effectiveSlugOf(infra, installationId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let client: Awaited<ReturnType<typeof connectAsPrincipal>> | undefined;
      try {
        client = await connectAsPrincipal(infra, auth, principalId, slug);
        const items: UpstreamItems = {
          tools: [],
          prompts: [],
          resources: [],
          resourceTemplates: [],
        };
        let degraded: string | undefined;
        for (const [key, method] of LIST_CALLS) {
          let cursor: string | undefined;
          do {
            let page: Record<string, unknown>;
            try {
              page =
                (await (client as unknown as Listable)[method]?.(cursor ? { cursor } : {})) ?? {};
            } catch (error) {
              if (key === 'tools') throw error;
              break; // the upstream does not implement this list
            }
            const meta = page._meta as Record<string, unknown> | undefined;
            const mark = meta?.[META_KEYS.degraded];
            if (mark !== undefined) degraded = JSON.stringify(mark);
            (items[key] as unknown[]).push(...((page[key] as unknown[] | undefined) ?? []));
            cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
          } while (cursor);
        }
        if (degraded && Date.now() < deadline) {
          await sleep(1_000);
          continue;
        }
        if (degraded) return { status: 'degraded', code: 'starting' };
        const instructions = client.getInstructions();
        return { status: 'ok', items: { ...items, ...(instructions ? { instructions } : {}) } };
      } catch (error) {
        if (error instanceof BastionError) throw error;
        return {
          status: 'degraded',
          code: error instanceof Error ? error.message.slice(0, 120) : 'list_failed',
        };
      } finally {
        await client?.close().catch(() => undefined);
      }
    }
  };

  return {
    listItems: (installationId, principalId) =>
      withEnabled(installationId, () => list(installationId, principalId, 0)),
    async listFresh(installationId, principalId, options = {}) {
      await dropListCaches(infra, installationId);
      return withEnabled(installationId, () =>
        list(installationId, principalId, options.timeoutMs ?? 120_000),
      );
    },
    async restart(installationId) {
      const record = await infra.repos.instances.getForInstallation(installationId);
      if (!record) return;
      await infra.redis.del(redisKeys.lease(record.id));
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
