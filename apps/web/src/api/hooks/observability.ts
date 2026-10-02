import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, fetchAll } from '../client';
import {
  BUCKET_MS,
  RANGE_MS,
  type CallFilters,
  type CallSeries,
  type CallViewer,
  type DriftDecision,
  bucketFor,
  callsQuery,
  driftViews,
  findingViews,
  guardTotals,
  latencyPoints,
  rangeWindow,
  sandboxSeries,
  scopedFilters,
  seriesFromCalls,
  seriesFromStats,
  type StatsRange,
  totalsByGroup,
} from '../views/observability';
import { keys, useApiMutation } from './base';
import { useMe } from './session';

/** The caller as the call log's authorization sees them, once `GET /me` has answered. */
const useViewer = (): CallViewer | undefined => {
  const me = useMe().data;
  return me ? { id: me.id, orgRole: me.orgRole, teams: me.teams } : undefined;
};

/** Names of people, teams and installations, read through the typed lists (generated fields only). */
export const useNames = (enabled = true) =>
  useQuery({
    queryKey: [...keys.stats, 'names'],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const [users, teams, installations] = await Promise.all([
        fetchAll('/users', undefined, 20, signal).catch(() => []),
        fetchAll('/teams', undefined, 20, signal).catch(() => []),
        fetchAll('/installations', undefined, 20, signal).catch(() => []),
      ]);
      return {
        users: new Map(users.map((u) => [u.id, u.displayName])),
        teams: new Map(teams.map((t) => [t.id, t.displayName])),
        installations: new Map(installations.map((i) => [i.id, i.displayName])),
      };
    },
  });

// --- calls ------------------------------------------------------------------------------------------------------

export const useCalls = (filters: CallFilters) => {
  const viewer = useViewer();
  const scoped = viewer ? scopedFilters(viewer, filters) : filters;
  return useInfiniteQuery({
    queryKey: [...keys.calls, scoped],
    enabled: Boolean(viewer),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/calls', {
        query: { ...callsQuery(scoped), limit: 50, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
  });
};

export const useCall = (id: string | null) =>
  useQuery({
    queryKey: [...keys.calls, 'detail', id],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get(`/calls/${id ?? ''}`, { signal }),
  });

// --- statistics -------------------------------------------------------------------------------------------------

/** `org` and `team` read the rollups; `me` reads the caller's own call rows. */
export type StatsScope = {
  scope?: 'org' | 'team' | 'me';
  teamId?: string;
  installationId?: string;
};
type StatsArgs = { range: StatsRange } & StatsScope;

const windowOf = (range: StatsRange) => {
  const to = Date.now();
  const bucket = bucketFor(range);
  return { bucket, from: to - RANGE_MS[range], to, step: BUCKET_MS[bucket] };
};

/**
 * Calls over time with a trend. The rollups cannot filter by installation or person, so those views are built from
 * call rows; org and team views come from `GET /stats/calls?groupBy=outcome`.
 */
export const useCallSeries = (args: StatsArgs) => {
  const viewer = useViewer();
  return useQuery<CallSeries>({
    queryKey: [...keys.stats, 'calls', 'time', args, viewer?.id],
    enabled: Boolean(viewer),
    queryFn: async ({ signal }) => {
      const w = windowOf(args.range);
      const window = { from: w.from, to: w.to, step: w.step };
      const rowsBased = args.scope === 'me' || args.installationId;
      if (rowsBased && viewer) {
        const filters = scopedFilters(
          viewer,
          args.scope === 'me'
            ? { user: viewer.id, ...(args.installationId ? { installationId: args.installationId } : {}) }
            : { ...(args.installationId ? { installationId: args.installationId } : {}) },
        );
        const rows = await fetchAll(
          '/calls',
          { ...callsQuery({ ...filters, range: args.range === '1h' || args.range === '7d' ? args.range : '24h' }, w.to) },
          10,
          signal,
        );
        return seriesFromCalls(rows, window);
      }
      const team = args.scope === 'team' ? args.teamId : undefined;
      const stats = await api.get('/stats/calls', {
        query: {
          groupBy: 'outcome',
          bucket: w.bucket,
          ...(team ? { team } : {}),
          from: new Date(w.from).toISOString(),
          to: new Date(w.to).toISOString(),
        },
        signal,
      });
      return seriesFromStats(stats, window);
    },
  });
};

const rangeQuery = (range: StatsRange, team?: string) => {
  const w = windowOf(range);
  return {
    bucket: w.bucket,
    from: new Date(w.from).toISOString(),
    to: new Date(w.to).toISOString(),
    ...(team ? { team } : {}),
  };
};

/** Calls per server, or per tool, over the range (`groupBy`). */
export const useCallTotals = (args: StatsArgs, groupBy: 'installation' | 'item') =>
  useQuery({
    queryKey: [...keys.stats, 'calls', groupBy, args],
    queryFn: ({ signal }) =>
      api
        .get('/stats/calls', {
          query: { groupBy, ...rangeQuery(args.range, args.scope === 'team' ? args.teamId : undefined) },
          signal,
        })
        .then(totalsByGroup),
  });

export const useLatency = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'latency', args],
    queryFn: ({ signal }) =>
      api.get('/stats/latency', { query: rangeQuery(args.range), signal }).then(latencyPoints),
  });

export const useSandboxStats = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'sandboxes', args],
    queryFn: ({ signal }) =>
      api.get('/stats/sandboxes', { query: rangeQuery(args.range), signal }).then(sandboxSeries),
  });

export const useGuardStats = (args: { range: StatsRange }) =>
  useQuery({
    queryKey: [...keys.stats, 'guards', args],
    queryFn: ({ signal }) =>
      api.get('/stats/guards', { query: rangeQuery(args.range), signal }),
    select: (stats) => ({ stats, totals: guardTotals(stats) }),
  });

// --- findings and drift ------------------------------------------------------------------------------------------

export const useFindings = (range: StatsRange) => {
  const names = useNames();
  return useQuery({
    queryKey: [...keys.stats, 'findings', range, names.data ? 'named' : 'bare'],
    queryFn: async ({ signal }) => {
      const { from, to } = rangeWindow(range);
      const rows = await fetchAll('/security/findings', { from, to }, 4, signal);
      return findingViews(rows, {
        users: names.data?.users ?? new Map(),
        installations: names.data?.installations ?? new Map(),
      });
    },
  });
};

/** Open (or all) definition-drift reviews, with the server names joined in. */
export const useDriftReviews = (status: 'open' | 'all' = 'open', enabled = true) =>
  useQuery({
    queryKey: [...keys.drift, status],
    enabled,
    queryFn: async ({ signal }) => {
      const [rows, installations] = await Promise.all([
        fetchAll('/drift-reviews', status === 'open' ? { status } : undefined, 20, signal),
        fetchAll('/installations', undefined, 20, signal).catch(() => []),
      ]);
      return driftViews(rows, new Map(installations.map((i) => [i.id, i.displayName])));
    },
  });

/** Approves (optional note) or rejects (reason required, 13.6) a definition change. */
export const useDecideDrift = () =>
  useApiMutation(
    (input: DriftDecision) =>
      input.decision === 'approve'
        ? api.post(`/drift-reviews/${input.id}/approve`, input.note ? { note: input.note } : {})
        : api.post(`/drift-reviews/${input.id}/reject`, { reason: input.reason }),
    [keys.drift, keys.installations, [...keys.stats, 'findings']],
  );
