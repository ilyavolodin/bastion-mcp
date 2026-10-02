import {
  type InstallationInput,
  type McpRequestContext,
  type PolicyDataInput,
  type PrincipalData,
  principalSchema,
  type ResourceData,
  requestContextSchema,
  resourceSchema,
} from '../src';

export const ORG = 'org';

const principal = (input: unknown): PrincipalData => principalSchema.parse(input);

export const admin = principal({ kind: 'user', id: 'admin1', role: 'admin' });
export const manager = principal({
  kind: 'user',
  id: 'mgr1',
  role: 'member',
  teams: [{ id: 't', slug: 'alpha', role: 'manager' }],
});
export const member = principal({
  kind: 'user',
  id: 'mem1',
  role: 'member',
  teams: [{ id: 't', slug: 'alpha', role: 'member' }],
});
export const auditor = principal({ kind: 'user', id: 'aud1', role: 'auditor' });
export const outsider = principal({
  kind: 'user',
  id: 'oth1',
  role: 'member',
  teams: [{ id: 'u', slug: 'beta', role: 'member' }],
});
export const serviceAccount = principal({ kind: 'service', id: 'sa1', team: { id: 't' } });

export const ROLES = { admin, manager, member, auditor } as const;

export const context: McpRequestContext = requestContextSchema.parse({
  clientId: 'claude-desktop',
  clientName: 'Claude Desktop',
  ip: '10.1.2.3',
  authMethod: 'oauth',
  hour: 10,
  weekday: 2,
  endpoint: '/mcp',
});

export const inst = (input: InstallationInput) => input;

export const instMember = inst({ id: 'inst-mem', catalogEntryId: 'e-org', ownerUserId: 'mem1' });
export const instAuditor = inst({ id: 'inst-aud', catalogEntryId: 'e-org', ownerUserId: 'aud1' });
export const instAdmin = inst({ id: 'inst-adm', catalogEntryId: 'e-org', ownerUserId: 'admin1' });
export const instManager = inst({ id: 'inst-mgr', catalogEntryId: 'e-org', ownerUserId: 'mgr1' });
export const instTeam = inst({ id: 'inst-team', catalogEntryId: 'e-t', ownerTeamId: 't' });
export const instOther = inst({ id: 'inst-oth', catalogEntryId: 'e-org', ownerUserId: 'oth1' });
export const instTeamU = inst({ id: 'inst-team-u', catalogEntryId: 'e-u', ownerTeamId: 'u' });
export const instService = inst({
  id: 'inst-sa',
  catalogEntryId: 'e-org',
  ownerServiceId: 'sa1',
  ownerServiceTeamId: 't',
});

export const data = (overrides: Partial<PolicyDataInput> = {}): PolicyDataInput => ({
  orgId: ORG,
  teams: [
    { id: 't', slug: 'alpha' },
    { id: 'u', slug: 'beta' },
  ],
  catalogEntries: [
    { id: 'e-org', visibility: { org: true, teamIds: [], userIds: [] }, risk: 'low' },
    {
      id: 'e-t',
      ownerTeamId: 't',
      visibility: { org: false, teamIds: ['t'], userIds: [] },
      risk: 'medium',
    },
    {
      id: 'e-u',
      ownerTeamId: 'u',
      visibility: { org: false, teamIds: ['u'], userIds: [] },
      risk: 'high',
    },
  ],
  installations: [
    instMember,
    instAuditor,
    instAdmin,
    instManager,
    instTeam,
    instOther,
    instTeamU,
    instService,
  ],
  ...overrides,
});

export const tool = (
  installation: InstallationInput,
  name: string,
  annotations: Record<string, boolean> = {},
): ResourceData => resourceSchema.parse({ type: 'Tool', installation, name, annotations });

export const prompt = (installation: InstallationInput, name: string): ResourceData =>
  resourceSchema.parse({ type: 'Prompt', installation, name });

export const resource = (installation: InstallationInput, uri: string): ResourceData =>
  resourceSchema.parse({ type: 'Resource', installation, uri });

export const installationResource = (installation: InstallationInput): ResourceData =>
  resourceSchema.parse({ type: 'Installation', ...installation });

export const userResource = (
  id: string,
  teamIds: string[] = [],
  extra: Record<string, unknown> = {},
): ResourceData => resourceSchema.parse({ type: 'User', id, teamIds, ...extra });

export const teamResource = (id: string): ResourceData =>
  resourceSchema.parse({ type: 'Team', id });
export const orgResource = (): ResourceData => resourceSchema.parse({ type: 'Org' });
export const entryResource = (id: string, extra: Record<string, unknown> = {}): ResourceData =>
  resourceSchema.parse({ type: 'CatalogEntry', id, ...extra });
