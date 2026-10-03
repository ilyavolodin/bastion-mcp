import { useQuery } from '@tanstack/react-query';
import { api, fetchAll } from '../client';
import type { Body, Schemas, TeamRole } from '../schema';
import { buildDirectory, type Directory, filterUsers } from '../views/access';
import { keys, pagedQuery, useApiMutation } from './base';

/** How many team detail requests run at once while the directory loads. */
const FAN_OUT = 6;

/**
 * People and teams, joined. `GET /users` has no team list and `GET /teams` has no members, so the directory reads
 * both lists and every team's detail (`GET /teams/{id}`); a team the caller may not read is left out.
 */
const loadDirectory = async (signal: AbortSignal): Promise<Directory> => {
  const [users, teams] = await Promise.all([
    fetchAll('/users', undefined, 20, signal),
    fetchAll('/teams', undefined, 20, signal),
  ]);
  const details: Schemas['TeamDetail'][] = [];
  for (let i = 0; i < teams.length; i += FAN_OUT) {
    const batch = await Promise.all(
      teams
        .slice(i, i + FAN_OUT)
        .map((t) => api.get(`/teams/${t.id}`, { signal }).catch(() => null)),
    );
    for (const d of batch) if (d) details.push(d);
  }
  return buildDirectory(users, details);
};

const directoryQuery = (enabled: boolean) => ({
  queryKey: [...keys.teams, 'directory'],
  queryFn: ({ signal }: { signal: AbortSignal }) => loadDirectory(signal),
  enabled,
});

export const useUsers = (params: { q?: string; teamId?: string } = {}, enabled = true) =>
  useQuery({
    ...directoryQuery(enabled),
    select: (d) => filterUsers(d.users, params),
  });

export const useTeams = (enabled = true) =>
  useQuery({ ...directoryQuery(enabled), select: (d) => d.teams });

const INVALIDATE_DIRECTORY = [keys.teams, keys.users];

export const useCreateTeam = () =>
  useApiMutation(
    (input: Body<'post', '/teams'>) => api.post('/teams', input),
    INVALIDATE_DIRECTORY,
  );

export const useSetMember = () =>
  useApiMutation(
    (input: { teamId: string; userId: string; role: TeamRole | null }) =>
      input.role
        ? api.put(`/teams/${input.teamId}/members/${input.userId}`, { role: input.role })
        : api.delete(`/teams/${input.teamId}/members/${input.userId}`),
    INVALIDATE_DIRECTORY,
  );

/**
 * `PATCH /users/{id}` (10.1): an Admin gives a person an organization role (Admin, Auditor or Member). The row's
 * version comes from the directory list (17.1). The last active Admin keeps the role (409 `last_admin`).
 */
export const useSetUserRole = () =>
  useApiMutation(
    (input: { userId: string; orgRole: Schemas['User']['orgRole'] }) =>
      api.patch(`/users/${input.userId}`, { orgRole: input.orgRole }),
    INVALIDATE_DIRECTORY,
  );

export const useDeactivateUser = () =>
  useApiMutation((id: string) => api.post(`/users/${id}/deactivate`), INVALIDATE_DIRECTORY);

// --- IdP group mapping ------------------------------------------------------------------------------------------
export const useRoleMappingRules = () =>
  useQuery(pagedQuery(keys.roleMapping, '/role-mapping-rules'));

export const useSaveRoleMapping = () =>
  useApiMutation(
    (input: { id?: string; rule: Body<'post', '/role-mapping-rules'> }) =>
      input.id
        ? api.patch(`/role-mapping-rules/${input.id}`, input.rule)
        : api.post('/role-mapping-rules', input.rule),
    [keys.roleMapping],
  );

export const useDeleteRoleMapping = () =>
  useApiMutation((id: string) => api.delete(`/role-mapping-rules/${id}`), [keys.roleMapping]);

// --- Service accounts -------------------------------------------------------------------------------------------
export const useServiceAccounts = () =>
  useQuery(pagedQuery(keys.serviceAccounts, '/service-accounts'));

/** The response carries the client id and, for `client_secret_basic`, the secret that is shown once. */
export const useCreateServiceAccount = () =>
  useApiMutation(
    (input: Body<'post', '/service-accounts'>) => api.post('/service-accounts', input),
    [keys.serviceAccounts],
  );

export const useRotateServiceAccount = () =>
  useApiMutation(
    (id: string) => api.post(`/service-accounts/${id}/credentials`, {}),
    [keys.serviceAccounts],
  );

export const useDeleteServiceAccount = () =>
  useApiMutation((id: string) => api.delete(`/service-accounts/${id}`), [keys.serviceAccounts]);

// --- OAuth clients ----------------------------------------------------------------------------------------------
export const useOAuthClients = () => useQuery(pagedQuery(keys.oauthClients, '/oauth-clients'));

export const useRegisterOAuthClient = () =>
  useApiMutation(
    (input: Body<'post', '/oauth-clients'>) => api.post('/oauth-clients', input),
    [keys.oauthClients],
  );

/** The row id of a client policy is its client id. */
export const usePatchOAuthClient = () =>
  useApiMutation(
    (input: { id: string; patch: Body<'patch', '/oauth-clients/{id}'> }) =>
      api.patch(`/oauth-clients/${encodeURIComponent(input.id)}`, input.patch),
    [keys.oauthClients],
  );

// --- Tool rules, custom policies, simulator ---------------------------------------------------------------------
export const usePolicyRules = () => useQuery(pagedQuery(keys.policyRules, '/policy-rules'));

export const useSavePolicyRule = () =>
  useApiMutation(
    (input: { id?: string; rule: Body<'post', '/policy-rules'> }) =>
      input.id
        ? api.patch(`/policy-rules/${input.id}`, input.rule)
        : api.post('/policy-rules', input.rule),
    [keys.policyRules],
  );

export const useDeletePolicyRule = () =>
  useApiMutation((id: string) => api.delete(`/policy-rules/${id}`), [keys.policyRules]);

export const useCustomPolicies = () =>
  useQuery(pagedQuery(keys.customPolicies, '/custom-policies'));

export const useSaveCustomPolicy = () =>
  useApiMutation(
    (input: { id?: string; policy: Body<'post', '/custom-policies'> }) =>
      input.id
        ? api.patch(`/custom-policies/${input.id}`, input.policy)
        : api.post('/custom-policies', input.policy),
    [keys.customPolicies],
  );

export const useDeleteCustomPolicy = () =>
  useApiMutation((id: string) => api.delete(`/custom-policies/${id}`), [keys.customPolicies]);

export const useValidatePolicy = () =>
  useApiMutation((input: Body<'post', '/policies/validate'>) =>
    api.post('/policies/validate', input),
  );

export const useSimulate = () =>
  useApiMutation((input: Body<'post', '/policies/simulate'>) =>
    api.post('/policies/simulate', input),
  );
