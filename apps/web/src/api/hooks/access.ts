import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import type {
  CustomPolicy,
  IdpConnection,
  IdpTestResult,
  LimitRule,
  ModelGuardConfig,
  OAuthClient,
  OrgSettings,
  PolicyRule,
  PolicyRuleInput,
  PolicyValidation,
  RoleMappingInput,
  RoleMappingRule,
  ServiceAccount,
  SimulationInput,
  SimulationResult,
  SystemStatus,
  Team,
  User,
} from '../types';
import { keys, listQuery, useApiMutation } from './base';

export const useUsers = (params: { q?: string; teamId?: string } = {}, enabled = true) =>
  useQuery({ ...listQuery<User>(keys.users, '/users', params), enabled });
export const useTeams = (enabled = true) =>
  useQuery({ ...listQuery<Team>(keys.teams, '/teams'), enabled });

export const useCreateTeam = () =>
  useApiMutation((input: { name: string }) => api.post<Team>('/teams', input), [keys.teams]);
export const useSetMember = () =>
  useApiMutation(
    (input: { teamId: string; userId: string; role: 'manager' | 'member' | null }) =>
      input.role
        ? api.put<void>(`/teams/${input.teamId}/members/${input.userId}`, { role: input.role })
        : api.delete(`/teams/${input.teamId}/members/${input.userId}`),
    [keys.teams, keys.users],
  );
export const useDeactivateUser = () =>
  useApiMutation((id: string) => api.post<void>(`/users/${id}/deactivate`), [keys.users]);

export const useRoleMappingRules = () =>
  useQuery(listQuery<RoleMappingRule>(keys.roleMapping, '/role-mapping-rules'));
export const useSaveRoleMapping = () =>
  useApiMutation(
    (input: { id?: string; rule: RoleMappingInput }) =>
      input.id
        ? api.patch<RoleMappingRule>(`/role-mapping-rules/${input.id}`, input.rule)
        : api.post<RoleMappingRule>('/role-mapping-rules', input.rule),
    [keys.roleMapping],
  );
export const useDeleteRoleMapping = () =>
  useApiMutation((id: string) => api.delete(`/role-mapping-rules/${id}`), [keys.roleMapping]);

export const useServiceAccounts = () =>
  useQuery(listQuery<ServiceAccount>(keys.serviceAccounts, '/service-accounts'));
export const useCreateServiceAccount = () =>
  useApiMutation(
    (input: { name: string; teamId: string }) => api.post<ServiceAccount>('/service-accounts', input),
    [keys.serviceAccounts],
  );
export const useDeleteServiceAccount = () =>
  useApiMutation((id: string) => api.delete(`/service-accounts/${id}`), [keys.serviceAccounts]);

export const useOAuthClients = () =>
  useQuery(listQuery<OAuthClient>(keys.oauthClients, '/oauth-clients'));
export const usePatchOAuthClient = () =>
  useApiMutation(
    (input: { id: string; status: 'approved' | 'blocked' }) =>
      api.patch<OAuthClient>(`/oauth-clients/${input.id}`, { status: input.status }),
    [keys.oauthClients],
  );

export const usePolicyRules = () => useQuery(listQuery<PolicyRule>(keys.policyRules, '/policy-rules'));
export const useSavePolicyRule = () =>
  useApiMutation(
    (input: { id?: string; rule: PolicyRuleInput }) =>
      input.id
        ? api.patch<PolicyRule>(`/policy-rules/${input.id}`, input.rule)
        : api.post<PolicyRule>('/policy-rules', input.rule),
    [keys.policyRules],
  );
export const useDeletePolicyRule = () =>
  useApiMutation((id: string) => api.delete(`/policy-rules/${id}`), [keys.policyRules]);
/** Assumed route (not in 17.2): dry-run a rule to count affected people and tools before saving. */
export const usePreviewPolicyRule = () =>
  useApiMutation((rule: PolicyRuleInput) =>
    api.post<{ people: number; tools: number }>('/policy-rules/preview', rule),
  );

export const useCustomPolicies = () =>
  useQuery(listQuery<CustomPolicy>(keys.customPolicies, '/custom-policies'));
export const useSaveCustomPolicy = () =>
  useApiMutation(
    (input: { id?: string; policy: Omit<CustomPolicy, 'id'> }) =>
      input.id
        ? api.patch<CustomPolicy>(`/custom-policies/${input.id}`, input.policy)
        : api.post<CustomPolicy>('/custom-policies', input.policy),
    [keys.customPolicies],
  );
export const useDeleteCustomPolicy = () =>
  useApiMutation((id: string) => api.delete(`/custom-policies/${id}`), [keys.customPolicies]);
export const useValidatePolicy = () =>
  useApiMutation((cedar: string) => api.post<PolicyValidation>('/policies/validate', { cedar }));
export const useSimulate = () =>
  useApiMutation((input: SimulationInput) => api.post<SimulationResult>('/policies/simulate', input));

// --- Settings and system -------------------------------------------------------------------------
export const usePatchSettings = () =>
  useApiMutation(
    (patch: Partial<OrgSettings>) => api.patch<OrgSettings>('/settings', patch),
    [keys.settings],
  );
export const useIdpConnections = () =>
  useQuery(listQuery<IdpConnection>(keys.idp, '/idp-connections'));
export const useSaveIdp = () =>
  useApiMutation(
    (input: { id?: string; idp: Omit<IdpConnection, 'id' | 'status' | 'lastTestAt'> & { clientSecret?: string } }) =>
      input.id
        ? api.patch<IdpConnection>(`/idp-connections/${input.id}`, input.idp)
        : api.post<IdpConnection>('/idp-connections', input.idp),
    [keys.idp],
  );
export const useTestIdp = () =>
  useApiMutation(
    (id: string) => api.post<IdpTestResult>(`/idp-connections/${id}/test`),
    [keys.idp],
  );
export const useModelGuards = () =>
  useQuery({
    queryKey: [...keys.settings, 'model-guards'],
    queryFn: ({ signal }) => api.get<ModelGuardConfig>('/settings/model-guards', { signal }),
  });
export const useSaveModelGuards = () =>
  useApiMutation(
    (cfg: ModelGuardConfig) => api.put<ModelGuardConfig>('/settings/model-guards', cfg),
    [[...keys.settings, 'model-guards']],
  );
export const useLimitRules = () => useQuery(listQuery<LimitRule>(keys.limits, '/limit-rules'));
export const useSaveLimitRule = () =>
  useApiMutation(
    (input: { id?: string; rule: Omit<LimitRule, 'id'> }) =>
      input.id
        ? api.patch<LimitRule>(`/limit-rules/${input.id}`, input.rule)
        : api.post<LimitRule>('/limit-rules', input.rule),
    [keys.limits],
  );
export const useDeleteLimitRule = () =>
  useApiMutation((id: string) => api.delete(`/limit-rules/${id}`), [keys.limits]);
export const useSystemStatus = (enabled = true) =>
  useQuery({
    queryKey: keys.system,
    enabled,
    refetchInterval: 30_000,
    queryFn: ({ signal }) => api.get<SystemStatus>('/system/status', { signal }),
  });
export const useRotateKms = () =>
  useApiMutation(() => api.post<void>('/system/kms/rotate'), [keys.system]);
