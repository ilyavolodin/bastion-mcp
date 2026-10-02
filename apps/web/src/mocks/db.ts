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
import { setDb } from './state';

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
  now: number;
  role: UiRole;
  me: Me;
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
    role,
    me: buildMe(role),
    seq: 100,
  };
}

export const resetDb = (role: UiRole = 'admin', now: number = Date.now()): MockDb =>
  setDb(createDb(role, now));
resetDb();

export { getDb, nextId, setRole } from './state';
