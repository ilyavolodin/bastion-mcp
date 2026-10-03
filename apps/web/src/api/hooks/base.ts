import {
  type QueryKey,
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { type ApiPath, fetchAll, type LooseQuery } from '../client';
import type { QueryOf } from '../schema';

/**
 * Query options for a cursor-paginated list endpoint that the screen wants in full. Items are typed by the
 * operation (`Schemas['TeamPage']['items']`), the query by its generated parameters.
 */
export const pagedQuery = <P extends ApiPath<'get'>>(
  key: QueryKey,
  path: P,
  query?: LooseQuery<QueryOf<'get', P>>,
) => ({
  queryKey: [...key, query ?? {}] as QueryKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchAll(path, query, undefined, signal),
});

/** A mutation that invalidates the given query-key prefixes once it succeeds. */
export function useApiMutation<TIn, TOut = unknown>(
  fn: (input: TIn) => Promise<TOut>,
  invalidate: QueryKey[] = [],
  options: Omit<UseMutationOptions<TOut, Error, TIn>, 'mutationFn'> = {},
) {
  const qc = useQueryClient();
  return useMutation<TOut, Error, TIn>({
    ...options,
    mutationFn: fn,
    onSuccess: async (data, vars, ctx, meta) => {
      await Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
      await options.onSuccess?.(data, vars, ctx, meta);
    },
  });
}

export const keys = {
  me: ['me'] as const,
  notifications: ['notifications'] as const,
  quotas: ['quotas'] as const,
  installations: ['installations'] as const,
  installation: (id: string) => ['installations', id] as const,
  endpoints: ['endpoints'] as const,
  store: ['store'] as const,
  calls: ['calls'] as const,
  stats: ['stats'] as const,
  drift: ['drift-reviews'] as const,
  catalog: ['catalog'] as const,
  autoInstall: ['auto-install'] as const,
  registry: ['registry'] as const,
  /** Not under `registry`: invalidating the registry lists must not forget which syncs were asked for. */
  syncRequests: ['registry-sync-requests'] as const,
  requests: ['install-requests'] as const,
  users: ['users'] as const,
  grants: ['oauth-grants'] as const,
  teams: ['teams'] as const,
  roleMapping: ['role-mapping'] as const,
  serviceAccounts: ['service-accounts'] as const,
  oauthClients: ['oauth-clients'] as const,
  policyRules: ['policy-rules'] as const,
  customPolicies: ['custom-policies'] as const,
  settings: ['settings'] as const,
  idp: ['idp'] as const,
  limits: ['limits'] as const,
  system: ['system'] as const,
  marketplaces: ['marketplaces'] as const,
  approvals: ['approvals'] as const,
};

export const useInvalidate = () => {
  const qc = useQueryClient();
  return (key: readonly unknown[]) => qc.invalidateQueries({ queryKey: key });
};
