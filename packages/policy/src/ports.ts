import type { PolicyDataInput, PrincipalInput } from './types';

/**
 * Port: everything the policy engine needs, as plain data (10.3). `packages/db` implements it from the
 * teams, catalog, installations, policy-rule and custom-policy tables; `policy` never touches a database.
 */
export interface PolicyDataSource {
  load(signal?: AbortSignal): Promise<PolicyDataInput>;
}

/**
 * Port: resolves a principal with its team memberships and roles, for callers that hold only an id (for
 * example the simulator). Workers normally build the principal from the token and the cached config.
 */
export interface PrincipalDirectory {
  find(
    ref: { kind: 'user' | 'service'; id: string },
    signal?: AbortSignal,
  ): Promise<PrincipalInput | null>;
}
