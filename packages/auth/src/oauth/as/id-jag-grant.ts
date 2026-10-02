import { errors, type KoaContextWithOIDC, type Provider } from 'oidc-provider';
import { JWT_BEARER_GRANT } from '../constants';
import type { PrincipalDirectory } from '../ports';
import { isAllowedResource, mcpResource } from '../urls';
import { runtime } from './provider-types';
import { resourceServerInfo } from './resource-server';

/** Verifies an ID-JAG for this AS (9.4). Throws when invalid; returns the Bastion user. */
export interface IdJagVerifier {
  verify(
    assertion: string,
    expect: { audience: string; resource: string; clientId: string },
  ): Promise<{ userId: string }>;
}

/** Registers the RFC 7523 jwt-bearer grant used for ID-JAG (9.4). */
export const registerJwtBearerGrant = (
  provider: Provider,
  deps: { host: string; issuer: string; verifier: IdJagVerifier; principals: PrincipalDirectory },
): void => {
  provider.registerGrantType(
    JWT_BEARER_GRANT,
    async (ctx: KoaContextWithOIDC) => {
      const params = ctx.oidc.params ?? {};
      const assertion = params.assertion;
      if (typeof assertion !== 'string' || assertion.length === 0) {
        throw new errors.InvalidRequest('missing required parameter assertion');
      }
      const resource =
        typeof params.resource === 'string' ? params.resource : mcpResource(deps.host);
      if (!isAllowedResource(deps.host, resource)) throw new errors.InvalidTarget();
      const client = ctx.oidc.client;
      if (!client) throw new errors.InvalidClient('client authentication required');
      let userId: string;
      try {
        ({ userId } = await deps.verifier.verify(assertion, {
          audience: deps.issuer,
          resource,
          clientId: client.clientId,
        }));
      } catch {
        throw new errors.InvalidGrant('invalid assertion');
      }
      if (!(await deps.principals.isUserActive(userId))) {
        throw new errors.InvalidGrant('user is not active');
      }
      const info = resourceServerInfo(deps.host, resource);
      const allowed = new Set(info.scope.split(' '));
      const requested =
        typeof params.scope === 'string' && params.scope ? params.scope.split(' ') : ['mcp'];
      const clientScopes = client.scope ? new Set(client.scope.split(' ')) : null;
      const scope = requested.filter(
        (s) => allowed.has(s) && (!clientScopes || clientScopes.has(s)),
      );
      if (scope.length === 0)
        throw new errors.InvalidScope('no requested scope is available', requested.join(' '));
      const rt = runtime(provider);
      const token = new rt.AccessToken({
        accountId: userId,
        client,
        gty: JWT_BEARER_GRANT,
        scope: scope.join(' '),
      });
      token.resourceServer = new rt.ResourceServer(resource, info);
      token.scope = scope.join(' ');
      ctx.oidc.entity('AccessToken', token as never);
      const value = await token.save();
      ctx.body = {
        access_token: value,
        expires_in: token.expiration,
        token_type: token.tokenType,
        scope: token.scope,
      };
    },
    ['assertion', 'scope', 'resource'],
  );
};
