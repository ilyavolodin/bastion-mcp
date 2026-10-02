import type { ProvisioningPlan, UserState } from '../provisioning/plan';
import type { RoleMappingRule, TeamRef } from '../provisioning/rules';
import type { FilterNode } from './filter';

export const SCIM_SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  serviceProvider: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
} as const;

export const SCIM_CONTENT_TYPE = 'application/scim+json';

export type ScimErrorType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

/** A SCIM protocol error (RFC 7644 3.12); rendered with `scimErrorBody`. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimErrorType,
  ) {
    super(detail);
    this.name = 'ScimError';
  }
}

export const scimErrorBody = (e: ScimError) => ({
  schemas: [SCIM_SCHEMAS.error],
  status: String(e.status),
  ...(e.scimType ? { scimType: e.scimType } : {}),
  detail: e.detail,
});

export type ScimRequest = {
  method: string;
  /** Path below `/scim/v2`, for example `/Users/123`. */
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
};

export type ScimResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type ScimUserRecord = {
  id: string;
  /** `userName` is the email address. */
  userName: string;
  displayName: string;
  externalId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date | null;
};

export type ScimGroupRecord = {
  /** The team id. */
  id: string;
  displayName: string;
  /** Members whose membership has source `scim`. */
  members: { id: string; display: string }[];
  createdAt: Date;
  updatedAt: Date | null;
};

export type ScimListQuery = { filter: FilterNode | null; startIndex: number; count: number };

/** Raised by a store when a plan violates a unique constraint (email or team slug). */
export class ScimStoreConflictError extends Error {}

/**
 * Persistence port for the SCIM server. SCIM Groups are teams carrying an `idp_group` (9.1: group
 * membership = team membership). `applyPlans` runs all plans in one transaction.
 */
export interface ScimStore {
  listUsers(q: ScimListQuery): Promise<{ total: number; items: ScimUserRecord[] }>;
  getUser(id: string): Promise<ScimUserRecord | null>;
  getUserState(id: string): Promise<UserState | null>;
  findUserIdByEmail(email: string): Promise<string | null>;
  listGroups(q: ScimListQuery): Promise<{ total: number; items: ScimGroupRecord[] }>;
  getGroup(id: string): Promise<ScimGroupRecord | null>;
  findGroupByName(displayName: string): Promise<ScimGroupRecord | null>;
  listTeamRefs(): Promise<TeamRef[]>;
  /** Teams (with `idp_group`) the user belongs to through SCIM. */
  userScimGroups(userId: string): Promise<{ teamId: string; name: string }[]>;
  listRules(connectionId: string | null): Promise<RoleMappingRule[]>;
  applyPlans(plans: readonly ProvisioningPlan[]): Promise<void>;
  renameGroup(id: string, displayName: string): Promise<void>;
  /** Stops exposing the team as a SCIM group (clears `idp_group`); the team and its resources stay. */
  detachGroup(id: string): Promise<void>;
}

export type ScimTokenRecord = {
  id: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export interface ScimTokenRepository {
  findByHash(tokenSha256: string): Promise<ScimTokenRecord | null>;
}

/** Runs the deactivation plan (9.1) for a user; wired by the server shell. */
export interface ScimDeactivator {
  deactivate(userId: string): Promise<void>;
}
