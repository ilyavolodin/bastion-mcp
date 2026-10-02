import type { ORG_ROLES, TEAM_ROLES } from '@bastion-mcp/core';

export type OrgRole = (typeof ORG_ROLES)[number];
export type TeamRole = (typeof TEAM_ROLES)[number];
export type PrincipalType = 'user' | 'service';
export type AuthMethod = 'oauth' | 'pat' | 'session';

export type TeamMembershipView = { teamId: string; role: TeamRole };

/**
 * The authenticated caller (9.3, 10.1). Shared by the downstream MCP server, the router and the
 * Cedar adapter; built once per request from a verified credential plus the cached principal record.
 */
export type Principal = {
  id: string;
  type: PrincipalType;
  orgRole: OrgRole;
  teams: readonly TeamMembershipView[];
  active: boolean;
  authMethod: AuthMethod;
  /** OAuth client that obtained the token; null for PATs and browser sessions. */
  clientId: string | null;
  scopes: readonly string[];
  /** Set for PATs restricted to one endpoint (9.3); the router enforces it (`assertEndpointAllowed`). */
  endpointRestriction: string | null;
  /** `jti` of the access token or id of the PAT; useful for audit. */
  credentialId: string | null;
};

/** The cached view of a user or service account (60 s cache, 9.3). Loaded through `PrincipalStore`. */
export type PrincipalRecord = {
  id: string;
  type: PrincipalType;
  orgRole: OrgRole;
  teams: readonly TeamMembershipView[];
  active: boolean;
};

export type CredentialContext = {
  authMethod: AuthMethod;
  clientId?: string | null;
  scopes: readonly string[];
  endpointRestriction?: string | null;
  credentialId?: string | null;
};

export const buildPrincipal = (record: PrincipalRecord, ctx: CredentialContext): Principal => ({
  id: record.id,
  type: record.type,
  orgRole: record.orgRole,
  teams: record.teams.map((t) => ({ teamId: t.teamId, role: t.role })),
  active: record.active,
  authMethod: ctx.authMethod,
  clientId: ctx.clientId ?? null,
  scopes: [...ctx.scopes],
  endpointRestriction: ctx.endpointRestriction ?? null,
  credentialId: ctx.credentialId ?? null,
});

export const hasScope = (principal: Pick<Principal, 'scopes'>, scope: string): boolean =>
  principal.scopes.includes(scope);

export const isManagerOf = (principal: Pick<Principal, 'teams'>, teamId: string): boolean =>
  principal.teams.some((t) => t.teamId === teamId && t.role === 'manager');

/** Router-side check for PATs restricted to one endpoint (9.3). */
export const endpointAllowed = (
  principal: Pick<Principal, 'endpointRestriction'>,
  endpointId: string,
): boolean =>
  principal.endpointRestriction === null || principal.endpointRestriction === endpointId;
