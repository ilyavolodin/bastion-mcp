import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../client';
import type {
  CallDetail,
  CallFilters,
  CallRecord,
  CallSeries,
  DriftReview,
  Finding,
  FlowStats,
  GuardStats,
  Page,
  LatencyBucket,
  SandboxStats,
  StatsRange,
  StatsScope,
} from '../types';
import { keys, listQuery, useApiMutation } from './base';

export const useCalls = (filters: CallFilters) =>
  useInfiniteQuery({
    queryKey: [...keys.calls, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<CallRecord>>('/calls', {
        query: { ...filters, limit: 50, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
  });

export const useCall = (id: string | null) =>
  useQuery({
    queryKey: [...keys.calls, 'detail', id],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get<CallDetail>(`/calls/${id}`, { signal }),
  });

type StatsArgs = { range: StatsRange } & StatsScope;
const statsQuery = (args: StatsArgs) => ({
  range: args.range,
  scope: args.scope,
  teamId: args.teamId,
  installationId: args.installationId,
});

export const useCallSeries = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'calls', 'time', args],
    queryFn: ({ signal }) =>
      api.get<CallSeries>('/stats/calls', {
        query: { groupBy: 'time', bucket: args.range === '1h' ? 'minute' : 'hour', ...statsQuery(args) },
        signal,
      }),
  });

export const useFlowStats = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'calls', 'flow', args],
    queryFn: ({ signal }) =>
      api.get<FlowStats>('/stats/calls', {
        query: { groupBy: 'client,installation', ...statsQuery(args) },
        signal,
      }),
  });

export const useLatency = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'latency', args],
    queryFn: ({ signal }) =>
      api
        .get<{ buckets: LatencyBucket[] }>('/stats/latency', { query: statsQuery(args), signal })
        .then((r) => r.buckets),
  });

export const useSandboxStats = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'sandboxes', args],
    queryFn: ({ signal }) =>
      api.get<SandboxStats>('/stats/sandboxes', { query: statsQuery(args), signal }),
  });

export const useGuardStats = (args: StatsArgs) =>
  useQuery({
    queryKey: [...keys.stats, 'guards', args],
    queryFn: ({ signal }) =>
      api.get<GuardStats>('/stats/guards', { query: statsQuery(args), signal }),
  });

export const useFindings = (range: StatsRange) =>
  useQuery(listQuery<Finding>([...keys.stats, 'findings'], '/security/findings', { range }));

export const useDriftReviews = (status: 'open' | 'all' = 'open', enabled = true) =>
  useQuery({
    ...listQuery<DriftReview>(keys.drift, '/drift-reviews', status === 'open' ? { status } : {}),
    enabled,
  });

export const useDecideDrift = () =>
  useApiMutation(
    (input: { id: string; decision: 'approve' | 'reject' }) =>
      api.post<void>(`/drift-reviews/${input.id}/${input.decision}`),
    [keys.drift, keys.installations],
  );
