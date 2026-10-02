import { useQuery } from '@tanstack/react-query';
import { api, fetchAll } from '../client';
import type { Body } from '../schema';
import {
  type RegistryServerView,
  type RequesterRef,
  toRequestView,
  toServerView,
} from '../views/registry';
import { useUsers } from './access';
import { keys, pagedQuery, useApiMutation } from './base';
import { useMe } from './session';

/** Source names by id. The source list is readable by everyone who can see the org; a failure only costs the names. */
const useSourceNames = (enabled = true) =>
  useQuery({
    queryKey: [...keys.registry, 'sources'],
    enabled,
    queryFn: async ({ signal }): Promise<Map<string, string>> =>
      new Map((await fetchAll('/registry-sources', undefined, 5, signal)).map((s) => [s.id, s.name])),
    retry: false,
  });

const STATUS_FILTER = { open: { status: 'open' }, all: undefined } as const;

/** Install requests the caller may see (all of them for admins, their teams' for managers, their own otherwise). */
export const useInstallRequests = (status: 'open' | 'all' = 'open', enabled = true) => {
  const users = useUsers({}, enabled);
  const sources = useSourceNames(enabled);
  const requesters = new Map<string, RequesterRef>(
    (users.data ?? []).map((u) => [u.id, { name: u.name, teams: u.teams.map((t) => t.name) }]),
  );
  return useQuery({
    ...pagedQuery(keys.requests, '/install-requests', STATUS_FILTER[status]),
    enabled,
    select: (rows) =>
      rows.map((r) => toRequestView(r, { requesters, sourceNames: sources.data ?? new Map() })),
  });
};

/** Registry servers with their source name and whether the caller already asked for them. */
export const useRegistryServers = (q: string) => {
  const sources = useSourceNames();
  const me = useMe();
  const requests = useQuery({
    ...pagedQuery(keys.requests, '/install-requests', { status: 'open' }),
    retry: false,
  });
  return useQuery({
    ...pagedQuery(keys.registry, '/registry/servers', q ? { q } : undefined),
    select: (rows): RegistryServerView[] =>
      rows.map((s) =>
        toServerView(s, {
          sourceNames: sources.data ?? new Map(),
          openRequests: requests.data ?? [],
          meId: me.data?.id ?? '',
        }),
      ),
  });
};

/**
 * Installs a registry server according to the source policy. The answer is `installed` (201) or `needs-request`
 * (202: the caller sends an install request instead); a denying policy is a 403 problem with the reasons.
 */
export const useRegistryInstall = () =>
  useApiMutation(
    (input: Body<'post', '/registry/install'>) => api.post('/registry/install', input),
    [keys.registry, keys.installations, keys.requests],
  );

export const useCreateInstallRequest = () =>
  useApiMutation(
    (input: Body<'post', '/install-requests'>) => api.post('/install-requests', input),
    [keys.requests, keys.registry],
  );

export const useApproveRequest = () =>
  useApiMutation(
    (id: string) => api.post(`/install-requests/${id}/approve`),
    [keys.requests, keys.installations],
  );

export const useRejectRequest = () =>
  useApiMutation(
    (input: { id: string; body: Body<'post', '/install-requests/{id}/reject'> }) =>
      api.post(`/install-requests/${input.id}/reject`, input.body),
    [keys.requests],
  );
