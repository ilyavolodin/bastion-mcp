/**
 * What the Registry screen shows, built from the rows of the API. A registry server row has no source name, no
 * install policy and no "already requested" flag; an install request row has ids, not names. The screens join them
 * here (source names from `GET /registry-sources`, requester names from `GET /users`, "requested" from the caller's
 * open requests). Everything else is the generated schema type.
 */
import type { Res, Schemas } from '../schema';
import { REGISTRY_SYNC_SKEW_MS, REGISTRY_SYNC_TIMEOUT_MS } from '../timing';

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

type NamespacePolicy = { allowedNamespaces: string[]; blockedNamespaces: string[] };

/**
 * The source policy that shows (`show`) or hides one server from members. The policy's namespace lists decide what is
 * shown AND what may be installed: hiding adds the exact name to the blocked list; showing takes it off that list and,
 * when the policy allows only certain names, adds it to the allowed ones. A pattern in the blocked list that covers
 * the name cannot be undone by name; the list then still says hidden and the settings are where to change the pattern.
 */
export const withVisibility = <P extends NamespacePolicy>(
  policy: P,
  name: string,
  show: boolean,
): P => {
  const blocked = policy.blockedNamespaces.filter((p) => p !== name);
  if (!show) {
    return { ...policy, blockedNamespaces: [...blocked, name] };
  }
  const allowsEverything = policy.allowedNamespaces.some((p) => p === '*' || p === '**');
  const allowed =
    allowsEverything || policy.allowedNamespaces.includes(name)
      ? policy.allowedNamespaces
      : [...policy.allowedNamespaces, name];
  return { ...policy, blockedNamespaces: blocked, allowedNamespaces: allowed };
};

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

/** When a sync was asked for, per source id. The screens keep it in the query cache (`useSyncRequests`). */
export type SyncRequests = ReadonlyMap<string, number>;
export const NO_SYNC_REQUESTS: SyncRequests = new Map();

/** The requests with one more: the sync of `sourceId` was asked for at `at` (epoch ms). */
export const withSyncRequested = (
  requests: SyncRequests,
  sourceId: string,
  at: number,
): SyncRequests => new Map(requests).set(sourceId, at);

/** The source has reported a walk that finished after the click (clock skew between server and browser allowed). */
const reportedSince = (source: Pick<RegistrySource, 'lastSync'>, at: number): boolean => {
  const info = syncInfo(source);
  return info !== null && Date.parse(info.finishedAt) >= at - REGISTRY_SYNC_SKEW_MS;
};

const expired = (at: number, now: number): boolean => now - at > REGISTRY_SYNC_TIMEOUT_MS;

/**
 * A sync was requested and the source has not reported anything newer yet (it times out after 15 minutes). Pure: the
 * requests and the clock are arguments; `pruneSyncRequests` forgets the ones that are over.
 */
export const isSyncing = (
  source: Pick<RegistrySource, 'id' | 'lastSync'>,
  requested: SyncRequests,
  now: number,
): boolean => {
  const at = requested.get(source.id);
  if (at === undefined || expired(at, now)) return false;
  return !reportedSince(source, at);
};

/** The requests without the ones that reported a result or timed out; the same map when nothing changed. */
export const pruneSyncRequests = (
  sources: readonly Pick<RegistrySource, 'id' | 'lastSync'>[],
  requested: SyncRequests,
  now: number,
): SyncRequests => {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const kept = [...requested].filter(([id, at]) => {
    const source = byId.get(id);
    return !expired(at, now) && !(source && reportedSince(source, at));
  });
  return kept.length === requested.size ? requested : new Map(kept);
};

/** The tag tone of a source's trust level. */
export const trustTone = (trust: string): 'ok' | 'info' | 'neutral' =>
  trust === 'official' ? 'ok' : trust === 'internal' ? 'info' : 'neutral';

export const TRUST_LABEL: Record<string, string> = {
  official: 'Official',
  internal: 'Internal',
  community: 'Community',
};
