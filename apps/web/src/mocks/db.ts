import type { Me, UiRole } from '@/api/views/session';
import { type AccessData, buildAccessData } from './domains/access';
import { buildCatalogData, type CatalogData } from './domains/catalog';
import { buildObservabilityData, type ObservabilityData } from './domains/observability';
import { buildPluginsData, type PluginsData } from './domains/plugins';
import { buildRegistryData, type RegistryData } from './domains/registry';
import { buildServersData, type ServersData } from './domains/servers';
import { buildSessionData, type SessionData } from './domains/session';
import { buildSettingsData, type SettingsData } from './domains/settings';
import { buildMe } from './me';
import { setDb, setDbFactory } from './state';

/** Rows in the shape of the real API (generated types), one slice per domain (`./domains/*`). */
export type DomainData = {
  access: AccessData;
  settings: SettingsData;
  catalog: CatalogData;
  servers: ServersData;
  observability: ObservabilityData;
  registry: RegistryData;
  plugins: PluginsData;
  session: SessionData;
};

export type MockDb = {
  data: DomainData;
  /** Mock time at creation; the mock clock (`util.ts`) adds the real time elapsed since `epoch`. */
  now: number;
  epoch: number;
  /** The last time handed out by the mock clock, so every stamp is later than the one before. */
  lastStamp: number;
  role: UiRole;
  me: Me;
  /** Version of the signed-in user's row: the ETag of `GET /me`. */
  meUpdatedAt: string;
  seq: number;
};

export function createDb(role: UiRole = 'admin', now: number = Date.now()): MockDb {
  return {
    data: {
      access: buildAccessData(now),
      settings: buildSettingsData(now),
      catalog: buildCatalogData(now),
      servers: buildServersData(now),
      observability: buildObservabilityData(now),
      registry: buildRegistryData(now),
      plugins: buildPluginsData(now),
      session: buildSessionData(now),
    },
    now,
    epoch: Date.now(),
    lastStamp: now,
    role,
    me: buildMe(role),
    meUpdatedAt: new Date(now - 2 * 24 * 3_600_000).toISOString(),
    seq: 100,
  };
}

/** Replaces the db with a fresh seeded one (tests do this after every test). */
export const resetDb = (role: UiRole = 'admin', now: number = Date.now()): MockDb =>
  setDb(createDb(role, now));
setDbFactory(() => createDb());

export { getDb, nextId, setRole } from './state';
