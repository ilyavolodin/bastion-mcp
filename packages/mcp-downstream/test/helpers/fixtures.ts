import { createHash } from 'node:crypto';
import { buildPrincipal, type Principal } from '@bastion-mcp/auth';
import type { PrincipalData } from '@bastion-mcp/policy';
import {
  compileEndpoint,
  type EffectiveEndpoint,
  type EndpointDefinition,
  type EndpointPolicy,
  type InstallationInfo,
  type UpstreamItemSource,
  type UpstreamItems,
  type UpstreamListResult,
} from '@bastion-mcp/router';
import type { BastionRequestContext } from '../../src/context';
import type { OpContext, ResolvedEndpoint } from '../../src/types';

/** A stable, schema-valid UUID derived from a label, so call-log rows validate. */
export const uuidFor = (label: string): string => {
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const USER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
export const OTHER_USER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
export const TEAM_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';

export const principal = (overrides: Partial<Principal> = {}): Principal => ({
  ...buildPrincipal(
    {
      id: USER_ID,
      type: 'user',
      orgRole: 'member',
      teams: [{ teamId: TEAM_ID, role: 'member' }],
      active: true,
    },
    { authMethod: 'oauth', clientId: 'client-1', scopes: ['mcp'], credentialId: 'jti-1' },
  ),
  ...overrides,
});

export const policyPrincipal = (id = USER_ID): PrincipalData => ({
  kind: 'user',
  id,
  role: 'member',
  active: true,
  emailDomain: '',
  teams: [{ id: TEAM_ID, role: 'member' }],
});

/** Allows everything and hides nothing; tests of Cedar behavior pass their own. */
export const allowAllPolicy: EndpointPolicy = {
  authorize: () => ({ decision: 'allow', reasons: ['test'], errors: [] }),
  filterVisible: (_request, items) => ({ visible: [...items], hidden: [] }),
};

export const installation = (
  slug: string,
  overrides: Partial<InstallationInfo> = {},
): InstallationInfo => ({
  id: uuidFor(`inst-${slug}`),
  slug,
  toolPrefix: slug.replace(/-/g, '_'),
  displayName: slug,
  owner: { kind: 'user', id: USER_ID },
  enabled: true,
  status: 'ready',
  catalogEntryId: uuidFor(`entry-${slug}`),
  catalogVersionId: uuidFor(`ver-${slug}`),
  layers: {},
  pinned: false,
  capabilities: { tools: true, prompts: true, resources: true, completions: true, subscribe: true },
  needsAuth: false,
  ...overrides,
});

export const items = (overrides: Partial<UpstreamItems> = {}): UpstreamItems => ({
  tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
  prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
  resources: [{ uri: 'test://static', name: 'static', mimeType: 'text/plain' }],
  resourceTemplates: [{ uriTemplate: 'test://items/{id}', name: 'item' }],
  ...overrides,
});

export const sourceOf = (
  byInstallation: Record<string, UpstreamItems | { status: 'degraded'; code: string }>,
): UpstreamItemSource => ({
  async listItems(info): Promise<UpstreamListResult> {
    const found = byInstallation[info.id];
    if (!found) return { status: 'degraded', code: 'missing' };
    if ('status' in found) return found;
    return { status: 'ok', items: found, origin: 'live' };
  },
});

export const requestContextForPolicy = {
  clientId: 'client-1',
  clientName: 'test',
  ip: '127.0.0.1',
  authMethod: 'oauth',
  hour: 12,
  weekday: 3,
  endpoint: '/mcp',
};

export const buildEndpoint = async (input: {
  installations: InstallationInfo[];
  items: Record<string, UpstreamItems | { status: 'degraded'; code: string }>;
  endpoint?: EndpointDefinition;
  policy?: EndpointPolicy;
}): Promise<ResolvedEndpoint> => {
  const definition: EndpointDefinition = input.endpoint ?? {
    id: 'default',
    kind: 'default',
    prefixMode: 'always',
  };
  const endpoint: EffectiveEndpoint = await compileEndpoint({
    principal: policyPrincipal(),
    endpoint: definition,
    installations: input.installations,
    source: sourceOf(input.items),
    policy: input.policy ?? allowAllPolicy,
    requestContext: requestContextForPolicy,
    org: { displayName: 'Acme' },
    serverVersion: '1.2.3',
    configVersion: '1',
  });
  return {
    definition,
    endpoint,
    installations: new Map(input.installations.map((i) => [i.id, i])),
  };
};

export const opContext = (
  resolved: ResolvedEndpoint,
  overrides: Partial<OpContext> = {},
): OpContext => ({
  principal: principal(),
  endpoint: resolved.endpoint,
  era: 'modern',
  protocolVersion: '2026-07-28',
  clientCapabilities: {},
  trace: { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 1 },
  signal: new AbortController().signal,
  emit: () => undefined,
  resolved,
  origin: 'client',
  ip: '127.0.0.1',
  authMethod: 'oauth',
  ...overrides,
});

export const requestContext = (
  resolved: ResolvedEndpoint,
  overrides: Partial<BastionRequestContext> = {},
): BastionRequestContext => ({
  principal: principal(),
  authInfo: { token: 'tok', clientId: 'client-1', scopes: ['mcp'] },
  tokenHash: 'hash-1',
  resolved,
  endpointPath: { kind: 'default' },
  requestUrl: 'http://localhost/mcp',
  path: '/mcp',
  ip: '127.0.0.1',
  origin: 'client',
  headers: {},
  ...overrides,
});
