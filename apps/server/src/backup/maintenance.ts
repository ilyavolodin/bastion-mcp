/**
 * Maintenance mode: one Redis flag every replica honours. While it is on, the MCP gateway and the OAuth endpoints answer
 * 503, and the console API accepts only reads and the system routes (backup, restore, turning it off). A replace restore
 * requires it, so nothing writes while the tables are swapped.
 */

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

const KEY = 'bastion:maintenance';
const CACHE_MS = 1_000;

export type MaintenanceState = {
  enabled: boolean;
  /** ISO time it was turned on. */
  since: string | null;
  /** Principal id (or "cli") that turned it on. */
  by: string | null;
};

const OFF: MaintenanceState = { enabled: false, since: null, by: null };

export type Maintenance = {
  get(): Promise<MaintenanceState>;
  /** Turning it on waits for the replicas' cache window, so nothing is served once it returns. */
  set(enabled: boolean, by: string): Promise<MaintenanceState>;
  /** Cached read used per request; at most `CACHE_MS` stale on another replica. */
  isOn(): Promise<boolean>;
};

export const createMaintenance = (redis: Redis, now: () => number = Date.now): Maintenance => {
  let cached: { at: number; state: MaintenanceState } | undefined;
  const read = async (): Promise<MaintenanceState> => {
    const raw = await redis.get(KEY);
    if (!raw) return OFF;
    try {
      return { ...OFF, ...(JSON.parse(raw) as Partial<MaintenanceState>), enabled: true };
    } catch {
      return { ...OFF, enabled: true };
    }
  };
  return {
    async get() {
      const state = await read();
      cached = { at: now(), state };
      return state;
    },
    async set(enabled, by) {
      if (enabled) {
        const state: MaintenanceState = {
          enabled: true,
          since: new Date(now()).toISOString(),
          by,
        };
        await redis.set(KEY, JSON.stringify(state));
        cached = { at: now(), state };
        // Returns only once every replica's cached copy of the flag has expired, so "on" means on everywhere.
        await new Promise((resolve) => setTimeout(resolve, CACHE_MS + 150));
        return state;
      }
      await redis.del(KEY);
      cached = { at: now(), state: OFF };
      return OFF;
    },
    async isOn() {
      if (cached && now() - cached.at < CACHE_MS) return cached.state.enabled;
      try {
        const state = await read();
        cached = { at: now(), state };
        return state.enabled;
      } catch {
        // Redis down: do not turn every request into an error because of a flag.
        return false;
      }
    },
  };
};

/** Paths that keep working during maintenance: health, the SPA shell and assets, sign-in. */
const gatewayPath = (path: string): boolean =>
  path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/oauth/');

const systemApiPath = (path: string): boolean => path.startsWith('/api/v1/system/');

/** Rejects gateway and OAuth traffic, and console writes outside `/api/v1/system/`, with 503 while the flag is on. */
export const registerMaintenanceGate = (app: FastifyInstance, maintenance: Maintenance): void => {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const consoleWrite =
      path.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !systemApiPath(path);
    if (!gatewayPath(path) && !consoleWrite) return;
    if (!(await maintenance.isOn())) return;
    return reply.code(503).header('retry-after', '60').send({
      error: 'maintenance',
      message: 'Bastion is in maintenance mode (a restore may be running). Try again shortly.',
    });
  });
};
