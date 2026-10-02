import {
  type QueryKey,
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query';
import { fetchAll, type Query } from '../client';

/** Query options for a cursor-paginated list endpoint that the screen wants in full. */
export const listQuery = <T>(key: QueryKey, path: string, query?: Query) => ({
  queryKey: [...key, query ?? {}] as QueryKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchAll<T>(path, query ?? {}, 20, signal),
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
  requests: ['install-requests'] as const,
  users: ['users'] as const,
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
