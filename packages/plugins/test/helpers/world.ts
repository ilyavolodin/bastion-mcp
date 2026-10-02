import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPluginsHandler,
  GitRepositoryCache,
  MemoryEventSink,
  MemoryMarketplaceStore,
  MemoryPluginAccess,
  MemoryReleaseStore,
  ReleaseService,
  toNodeListener,
} from '../../src';
import { asResolved, marketplaceRow, sampleItems } from './items';

export const HOST = 'mcp.example.com';

export type World = Awaited<ReturnType<typeof createWorld>>;

/** Memory stores, a release service, the git cache and the `/plugins` handler wired together. */
export const createWorld = async (options: { startTime?: Date } = {}) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'bastion-world-'));
  const marketplaces = new MemoryMarketplaceStore();
  const releases = new MemoryReleaseStore(marketplaces);
  const marketplace = marketplaceRow();
  marketplaces.add(marketplace);
  marketplaces.current = asResolved(sampleItems());
  const access = new MemoryPluginAccess();
  access.tokens.set('good-token', { id: 'user-1', scopes: ['plugins:read', 'offline_access'] });
  access.tokens.set('wrong-scope', { id: 'user-1', scopes: ['mcp'] });
  access.tokens.set('outsider', { id: 'user-2', scopes: ['plugins:read'] });
  access.audience.set(marketplace.id, new Set(['user-1']));
  const events = new MemoryEventSink();
  let now = options.startTime ?? new Date('2026-10-01T12:00:00.500Z');
  const clock = { now: () => now };
  const service = new ReleaseService({ host: HOST, marketplaces, releases, clock });
  const repositories = new GitRepositoryCache({ cacheDir, host: HOST, marketplaces, releases });
  const handler = createPluginsHandler({
    host: HOST,
    access,
    marketplaces,
    releases,
    releaseService: service,
    repositories,
    events,
    clock,
  });
  const servers: Server[] = [];
  return {
    cacheDir,
    marketplaces,
    releases,
    marketplace,
    access,
    events,
    service,
    repositories,
    handler,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    listen: async (): Promise<string> => {
      const server = createServer(toNodeListener(handler, { origin: `https://${HOST}` }));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: async () => {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
};

export const basic = (token: string, user = 'x-access-token'): string =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
