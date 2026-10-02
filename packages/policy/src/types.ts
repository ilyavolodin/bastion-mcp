import { ORG_ROLES, POLICY_EFFECTS, RISK_LEVELS, TEAM_ROLES } from '@bastion-mcp/core';
import { z } from 'zod';
import { ALL_ACTIONS, type PolicyAction } from './schema';

const id = z.string().min(1).max(256);

export const orgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRoleSchema>;
export const teamRoleSchema = z.enum(TEAM_ROLES);

// --- principals ----------------------------------------------------------------------------------

const teamMembershipSchema = z.object({
  id,
  slug: z.string().max(256).optional(),
  role: teamRoleSchema,
});

export const userPrincipalSchema = z.object({
  kind: z.literal('user'),
  id,
  role: orgRoleSchema,
  active: z.boolean().default(true),
  emailDomain: z.string().max(256).default(''),
  teams: z.array(teamMembershipSchema).default([]),
});

export const servicePrincipalSchema = z.object({
  kind: z.literal('service'),
  id,
  active: z.boolean().default(true),
  /** A service account belongs to exactly one team (10.1). */
  team: z.object({ id, slug: z.string().max(256).optional() }),
});

export const principalSchema = z.discriminatedUnion('kind', [
  userPrincipalSchema,
  servicePrincipalSchema,
]);
export type UserPrincipal = z.infer<typeof userPrincipalSchema>;
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;
export type PrincipalData = z.infer<typeof principalSchema>;
export type PrincipalInput = z.input<typeof principalSchema>;

// --- resources -----------------------------------------------------------------------------------

export const visibilitySchema = z.object({
  org: z.boolean().default(false),
  teamIds: z.array(id).default([]),
  userIds: z.array(id).default([]),
});
export type CatalogVisibility = z.infer<typeof visibilitySchema>;

const catalogEntryAttrs = z.object({
  ownerTeamId: id.optional(),
  visibility: visibilitySchema.optional(),
  risk: z.enum(RISK_LEVELS).default('low'),
});

export const installationSchema = z.object({
  id,
  catalogEntryId: id,
  ownerUserId: id.optional(),
  ownerTeamId: id.optional(),
  ownerServiceId: id.optional(),
  /** The owning service account's team, so managers of that team administer the installation (10.1). */
  ownerServiceTeamId: id.optional(),
  catalogEntry: catalogEntryAttrs.optional(),
});
export type InstallationData = z.infer<typeof installationSchema>;
export type InstallationInput = z.input<typeof installationSchema>;

/** Final tool annotations after overrides (10.2); missing hints take the MCP defaults. */
export const toolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;

export const resourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Org') }),
  z.object({ type: z.literal('Team'), id, slug: z.string().max(256).optional() }),
  z.object({
    type: z.literal('User'),
    id,
    role: orgRoleSchema.default('member'),
    active: z.boolean().default(true),
    emailDomain: z.string().max(256).default(''),
    teamIds: z.array(id).default([]),
    managedTeamIds: z.array(id).default([]),
  }),
  z.object({ type: z.literal('CatalogEntry'), id, ...catalogEntryAttrs.shape }),
  z.object({ type: z.literal('Installation'), ...installationSchema.shape }),
  z.object({
    type: z.literal('Tool'),
    installation: installationSchema,
    name: z.string().min(1).max(512),
    annotations: toolAnnotationsSchema.default({}),
  }),
  z.object({
    type: z.literal('Prompt'),
    installation: installationSchema,
    name: z.string().min(1).max(512),
  }),
  z.object({
    type: z.literal('Resource'),
    installation: installationSchema,
    uri: z.string().min(1).max(4096),
  }),
]);
export type ResourceData = z.infer<typeof resourceSchema>;
export type ResourceInput = z.input<typeof resourceSchema>;

export type ToolResource = Extract<ResourceData, { type: 'Tool' }>;
export type PromptResource = Extract<ResourceData, { type: 'Prompt' }>;
export type ResourceResource = Extract<ResourceData, { type: 'Resource' }>;
export type VisibilityResource = ToolResource | PromptResource | ResourceResource;

// --- request context -----------------------------------------------------------------------------

export const requestContextSchema = z.object({
  clientId: z.string().max(512),
  clientName: z.string().max(512).default(''),
  ip: z.string().min(2).max(64),
  authMethod: z.string().max(64),
  hour: z.number().int().min(0).max(23),
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: z.number().int().min(0).max(6),
  endpoint: z.string().max(512).default(''),
});
export type McpRequestContext = z.infer<typeof requestContextSchema>;
export type McpRequestContextInput = z.input<typeof requestContextSchema>;

// --- tool rules (10.3) ---------------------------------------------------------------------------

const safeName = z.string().min(1).max(512);

export const argConditionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('eq'), name: safeName, value: z.string().max(1024) }),
  z.object({ op: z.literal('ne'), name: safeName, value: z.string().max(1024) }),
  z.object({ op: z.literal('in'), name: safeName, values: z.array(z.string().max(1024)).min(1) }),
  z.object({ op: z.literal('like'), name: safeName, pattern: z.string().max(1024) }),
  z.object({ op: z.literal('exists'), name: safeName }),
  z.object({ op: z.literal('notExists'), name: safeName }),
]);
export type ArgCondition = z.infer<typeof argConditionSchema>;

export const ruleWhoSchema = z.object({
  role: z.enum([...ORG_ROLES, 'manager']).optional(),
  teams: z.array(id).optional(),
  users: z.array(id).optional(),
  serviceAccounts: z.array(id).optional(),
});

export const ruleWhatSchema = z.object({
  installationId: id.optional(),
  catalogEntryId: id.optional(),
  /** Tool name or glob; `*` is the only wildcard. */
  toolName: z.string().min(1).max(512).optional(),
  annotations: z
    .object({
      readOnly: z.boolean().optional(),
      destructive: z.boolean().optional(),
      openWorld: z.boolean().optional(),
    })
    .optional(),
});

export const ruleWhenSchema = z.object({
  clientIds: z.array(z.string().min(1).max(512)).optional(),
  /** Local hours `from` (inclusive) to `to` (exclusive); wraps past midnight when `from > to`. */
  hours: z
    .object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(24) })
    .optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  ipCidrs: z
    .array(z.string().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'not an IP address or CIDR'))
    .optional(),
  args: z.array(argConditionSchema).optional(),
});

export const toolRuleRowSchema = z.object({
  id: z.string().min(1).max(128),
  effect: z.enum(POLICY_EFFECTS),
  who: ruleWhoSchema.default({}),
  what: ruleWhatSchema.default({}),
  when: ruleWhenSchema.default({}),
});
export type ToolRuleRow = z.infer<typeof toolRuleRowSchema>;
export type ToolRuleRowInput = z.input<typeof toolRuleRowSchema>;

// --- policy data (the PolicyDataSource payload) ----------------------------------------------------

export const customPolicySchema = z.object({ id: z.string().min(1).max(128), cedar: z.string() });
export type CustomPolicyData = z.infer<typeof customPolicySchema>;

export const policyDataSchema = z.object({
  /** Entity id of the single organization (default `org`). */
  orgId: id.default('org'),
  settings: z.object({ logsManagerVisibility: z.boolean().default(true) }).default({
    logsManagerVisibility: true,
  }),
  /** Users holding `catalog.publishOrgWide` (10.1). */
  orgWidePublisherIds: z.array(id).default([]),
  teams: z.array(z.object({ id, slug: z.string().max(256).optional() })).default([]),
  catalogEntries: z
    .array(
      z.object({
        id,
        ownerTeamId: id.optional(),
        visibility: visibilitySchema,
        risk: z.enum(RISK_LEVELS).default('low'),
      }),
    )
    .default([]),
  installations: z.array(installationSchema).default([]),
  rules: z.array(toolRuleRowSchema).default([]),
  customPolicies: z.array(customPolicySchema).default([]),
});
export type PolicyData = z.infer<typeof policyDataSchema>;
export type PolicyDataInput = z.input<typeof policyDataSchema>;

/** One compiled Cedar policy and the id Bastion reports as a decision reason. */
export type PolicyEntry = { id: string; text: string };

// --- requests and decisions ------------------------------------------------------------------------

export const policyActionSchema = z.enum(ALL_ACTIONS as readonly [PolicyAction, ...PolicyAction[]]);

export type Decision = {
  decision: 'allow' | 'deny';
  /** Ids of the policies that determined the decision; empty for a default deny. */
  reasons: string[];
  /** Ids of policies that errored during evaluation (Cedar skips them). */
  errors: string[];
};

export type AuthorizeRequest = {
  principal: PrincipalData;
  action: PolicyAction;
  resource: ResourceData;
  /** Required for MCP actions, ignored for management actions. */
  context?: McpRequestContext;
  /** `tools/call` arguments; become tags on the per-call `ToolCall` entity. */
  call?: Record<string, unknown>;
};
