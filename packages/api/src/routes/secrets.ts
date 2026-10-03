import type { ResourceData } from '@bastion-mcp/policy';
import {
  type Authz,
  authz,
  defineDelete,
  defineMutation,
  defineRoute,
  type RouteDefinition,
} from '../framework/route';
import type { SecretScope } from '../ports/secrets';
import {
  secretListQuery,
  secretListSchema,
  secretMetaSchema,
  secretParams,
  secretPutBody,
} from '../schemas/secrets';
import { loadUserResource } from '../services/resources';
import { deleteSecret, listSecrets, putSecret, secretVersion } from '../services/secrets';
import { org } from './shared';

const TAG = 'Secrets';

const MISSING_USER: ResourceData = {
  type: 'User',
  id: 'missing',
  role: 'member',
  active: true,
  emailDomain: '',
  teamIds: [],
  managedTeamIds: [],
};

const RULE: Record<SecretScope, string> = {
  org: 'secrets.org',
  team: 'secrets.team',
  user: 'secrets.user',
};

const resourceFor = async (
  scope: SecretScope,
  ownerId: string | undefined,
  deps: Parameters<typeof loadUserResource>[0],
): Promise<ResourceData> => {
  if (scope === 'org') return org();
  if (scope === 'team') return { type: 'Team', id: ownerId ?? '' };
  return (ownerId ? await loadUserResource(deps, ownerId) : null) ?? MISSING_USER;
};

const scopeAuthz = (scope: SecretScope): Authz =>
  authz.on(RULE[scope], (input) => resourceFor(scope, input.params.ownerId, input.deps));

const SCOPES: readonly SecretScope[] = ['org', 'team', 'user'];

const perScope = (scope: SecretScope): RouteDefinition[] => [
  defineMutation({
    method: 'PUT',
    url: `/secrets/${scope}/{ownerId}/{name}`,
    tag: TAG,
    summary: `Create or replace a ${scope} secret (the value is never returned)`,
    schema: { params: secretParams, body: secretPutBody, response: secretMetaSchema },
    authz: scopeAuthz(scope),
    status: 200,
    version: (input) =>
      secretVersion(input, scope, input.params.ownerId ?? '', input.params.name ?? ''),
    handler: (ctx) => putSecret(ctx, scope, ctx.params.ownerId, ctx.params.name, ctx.body.value),
  }),
  defineDelete({
    url: `/secrets/${scope}/{ownerId}/{name}`,
    tag: TAG,
    summary: `Delete a ${scope} secret`,
    params: secretParams,
    authz: scopeAuthz(scope),
    version: (input) =>
      secretVersion(input, scope, input.params.ownerId ?? '', input.params.name ?? ''),
    remove: (ctx) => deleteSecret(ctx, scope, ctx.params.ownerId, ctx.params.name),
  }),
];

export const secretsRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/secrets',
    tag: TAG,
    summary: 'Secret names and metadata for a scope (never values)',
    schema: { query: secretListQuery, response: secretListSchema },
    authz: authz.oneOf(
      SCOPES.map((s) => RULE[s]),
      async (input) => {
        const scope = SCOPES.find((s) => s === input.query.scope) ?? 'org';
        const owner =
          scope === 'user' ? (input.query.ownerId ?? input.principal.id) : input.query.ownerId;
        return { rule: RULE[scope], resource: await resourceFor(scope, owner, input.deps) };
      },
    ),
    handler: async (ctx) => ({
      items: await listSecrets(ctx, ctx.query.scope, ctx.query.ownerId),
    }),
  }),
  ...SCOPES.flatMap(perScope),
];
