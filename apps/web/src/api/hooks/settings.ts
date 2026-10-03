import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import type { Body } from '../schema';
import { POLL_SYSTEM_MS } from '../timing';
import { keys, pagedQuery, useApiMutation } from './base';

// --- Org settings (read by many screens) ---------------------------------------------------------------
/** `GET /settings` answers `{ settings, updatedAt }`; screens read the settings document. */
export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => api.get('/settings', { signal }),
    select: (view) => view.settings,
  });

/** Replaces the top-level keys it names (each key is validated whole); sends the remembered `If-Match`. */
export const usePatchSettings = () =>
  useApiMutation(
    (patch: Body<'patch', '/settings'>) => api.patch('/settings', patch),
    [keys.settings],
  );

// --- Identity providers --------------------------------------------------------------------------------
export const useIdpConnections = () => useQuery(pagedQuery(keys.idp, '/idp-connections'));

export const useCreateIdp = () =>
  useApiMutation(
    (body: Body<'post', '/idp-connections'>) => api.post('/idp-connections', body),
    [keys.idp],
  );

export const useUpdateIdp = () =>
  useApiMutation(
    (input: { id: string; body: Body<'patch', '/idp-connections/{id}'> }) =>
      api.patch(`/idp-connections/${input.id}`, input.body),
    [keys.idp],
  );

export const useTestIdp = () =>
  useApiMutation((id: string) => api.post(`/idp-connections/${id}/test`));

// --- Model guards ----------------------------------------------------------------------------------------
const MODEL_GUARDS_KEY = [...keys.settings, 'model-guards'] as const;

export const useModelGuards = () =>
  useQuery({
    queryKey: MODEL_GUARDS_KEY,
    queryFn: ({ signal }) => api.get('/settings/model-guards', { signal }),
  });

export const useSaveModelGuards = () =>
  useApiMutation(
    (body: Body<'put', '/settings/model-guards'>) => api.put('/settings/model-guards', body),
    [MODEL_GUARDS_KEY],
  );

// --- Limit rules (14) ---------------------------------------------------------------------------------------
export const useLimitRules = () => useQuery(pagedQuery(keys.limits, '/limit-rules'));

export const useCreateLimitRule = () =>
  useApiMutation(
    (body: Body<'post', '/limit-rules'>) => api.post('/limit-rules', body),
    [keys.limits],
  );

export const usePatchLimitRule = () =>
  useApiMutation(
    (input: { id: string; body: Body<'patch', '/limit-rules/{id}'> }) =>
      api.patch(`/limit-rules/${input.id}`, input.body),
    [keys.limits],
  );

export const useDeleteLimitRule = () =>
  useApiMutation((id: string) => api.delete(`/limit-rules/${id}`), [keys.limits]);

// --- System ---------------------------------------------------------------------------------------------------
export const useSystemStatus = (enabled = true) =>
  useQuery({
    queryKey: keys.system,
    enabled,
    refetchInterval: POLL_SYSTEM_MS,
    queryFn: ({ signal }) => api.get('/system/status', { signal }),
  });

export const useRotateKms = () =>
  useApiMutation(() => api.post('/system/kms/rotate'), [keys.system]);
