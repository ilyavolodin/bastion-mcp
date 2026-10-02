/**
 * What the Registry screen shows, built from the rows of the API. A registry server row has no source name, no
 * install policy and no "already requested" flag; an install request row has ids, not names. The screens join them
 * here (source names from `GET /registry-sources`, requester names from `GET /users`, "requested" from the caller's
 * open requests). Everything else is the generated schema type.
 */
import type { Res, Schemas } from '../schema';

export type RegistryServer = Schemas['RegistryServer'];
export type RegistryServerDetail = Schemas['RegistryServerDetail'];
export type InstallRequest = Schemas['InstallRequest'];
export type RegistryInstallResult = Schemas['RegistryInstallResult'];
export type RegistrySource = Schemas['RegistrySource'];
export type RegistryServerPage = Res<'get', '/registry/servers'>;

/** Labels of the runtimes a registry entry can run on (`runtimes` of the row). */
export const RUNTIME_TAGS: Record<string, string> = {
  remote: 'Remote',
  npm: 'npm',
  pypi: 'Python',
};

export const runtimeLabel = (runtime: string): string => RUNTIME_TAGS[runtime] ?? runtime;

/** Key of a registry entry across lists: a server version belongs to one source. */
export const serverKey = (s: { sourceId: string; name: string; version: string }): string =>
  `${s.sourceId}/${s.name}@${s.version}`;

export type RegistryServerView = RegistryServer & {
  /** Name of the source, or its id when the caller may not read the source list. */
  sourceName: string;
  /** The caller has an open request for this exact server version. */
  requested: boolean;
};

export const toServerView = (
  server: RegistryServer,
  ctx: {
    sourceNames: ReadonlyMap<string, string>;
    openRequests: readonly Pick<
      InstallRequest,
      'sourceId' | 'serverName' | 'version' | 'status' | 'requesterId'
    >[];
    meId: string;
  },
): RegistryServerView => ({
  ...server,
  sourceName: ctx.sourceNames.get(server.sourceId) ?? server.sourceId,
  requested: ctx.openRequests.some(
    (r) =>
      r.status === 'open' &&
      r.requesterId === ctx.meId &&
      r.sourceId === server.sourceId &&
      r.serverName === server.name &&
      r.version === server.version,
  ),
});

export type RequesterRef = { name: string; teams: string[] };

export type InstallRequestView = InstallRequest & {
  requesterName: string;
  /** The requester's first team, which a manager reviews the request for. */
  teamName: string | null;
  sourceName: string;
  /** What the person wrote (`justification`); empty when they gave none. */
  reason: string;
};

export const toRequestView = (
  request: InstallRequest,
  ctx: {
    requesters: ReadonlyMap<string, RequesterRef>;
    sourceNames: ReadonlyMap<string, string>;
  },
): InstallRequestView => {
  const who = ctx.requesters.get(request.requesterId);
  return {
    ...request,
    requesterName: who?.name ?? request.requesterId,
    teamName: who?.teams[0] ?? null,
    sourceName: ctx.sourceNames.get(request.sourceId) ?? request.sourceId,
    reason: request.justification ?? '',
  };
};

/** What the policy decided for an install, in words for a toast or a dialog. */
export const reasonsText = (reasons: readonly string[]): string =>
  reasons.length > 0 ? reasons.join('. ') : 'The registry policy decides.';

/** What `last_sync` of a source holds (`SyncStats` of the registry package; the API types it as unknown). */
export type SyncInfo = {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  full: boolean;
  pages: number;
  fetched: number;
  upserted: number;
  invalid: number;
  deleted: number;
  deprecated: number;
  error?: string;
};

export const syncInfo = (source: Pick<RegistrySource, 'lastSync'>): SyncInfo | null => {
  const raw = source.lastSync;
  if (typeof raw !== 'object' || raw === null || typeof (raw as SyncInfo).startedAt !== 'string') {
    return null;
  }
  return raw as SyncInfo;
};

/** Sync requests are remembered here until the source reports a result newer than the click. */
const requested = new Map<string, number>();
export const markSyncRequested = (sourceId: string, at = Date.now()): void => {
  requested.set(sourceId, at);
};

/** A sync was requested and the source has not reported anything newer yet (it times out after 15 minutes). */
export const isSyncing = (source: Pick<RegistrySource, 'id' | 'lastSync'>): boolean => {
  const at = requested.get(source.id);
  if (at === undefined) return false;
  if (Date.now() - at > 15 * 60_000) {
    requested.delete(source.id);
    return false;
  }
  const info = syncInfo(source);
  const finished = info ? Date.parse(info.finishedAt) : 0;
  // The stats of a finished walk are written after the clicks; allow for clock skew between server and browser.
  if (info && finished >= at - 5_000) {
    requested.delete(source.id);
    return false;
  }
  return true;
};

export const TRUST_LABEL: Record<string, string> = {
  official: 'Official',
  internal: 'Internal',
  community: 'Community',
};
