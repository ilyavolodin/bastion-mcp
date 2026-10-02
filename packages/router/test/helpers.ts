import {
  type McpRequestContext,
  PolicyEngine,
  type PrincipalData,
  principalSchema,
  requestContextSchema,
} from '@bastion-mcp/policy';
import type { InstallationInfo, UpstreamItems } from '../src/types';

export const principal: PrincipalData = principalSchema.parse({
  kind: 'user',
  id: 'u1',
  role: 'member',
  teams: [{ id: 't1', slug: 'eng', role: 'member' }],
});

export const requestContext: McpRequestContext = requestContextSchema.parse({
  clientId: 'c',
  ip: '10.0.0.1',
  authMethod: 'oauth',
  hour: 10,
  weekday: 2,
  endpoint: '/mcp',
});

export const installation = (
  over: Partial<InstallationInfo> & { id: string; slug: string },
): InstallationInfo => ({
  toolPrefix: over.slug.replace(/-/g, '_'),
  displayName: over.slug,
  owner: { kind: 'user', id: 'u1' },
  enabled: true,
  status: 'ready',
  catalogEntryId: `e-${over.id}`,
  layers: {},
  pinned: false,
  capabilities: { tools: true },
  needsAuth: false,
  ...over,
});

export const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object' as const, properties: { q: { type: 'string' } } },
  ...extra,
});

export const items = (over: Partial<UpstreamItems> = {}): UpstreamItems => ({
  tools: [],
  prompts: [],
  resources: [],
  resourceTemplates: [],
  ...over,
});

/** Policy data for the installations; everything is owned by u1 or team t1. */
export const engineFor = (installations: readonly InstallationInfo[], rules: unknown[] = []) =>
  PolicyEngine.create({
    teams: [{ id: 't1', slug: 'eng' }],
    catalogEntries: installations.map((i) => ({
      id: i.catalogEntryId,
      visibility: { org: true, teamIds: [], userIds: [] },
      risk: 'low' as const,
    })),
    installations: installations.map((i) => ({
      id: i.id,
      catalogEntryId: i.catalogEntryId,
      ...(i.owner.kind === 'user' ? { ownerUserId: i.owner.id } : {}),
      ...(i.owner.kind === 'team' ? { ownerTeamId: i.owner.id } : {}),
    })),
    rules: rules as never,
  });
