/** Plugin distribution (25.5): the git smart-HTTP channel and the HTTPS manifest and archives under `/plugins/*`. */
import { AuthenticationError, InsufficientScopeError, type Principal } from '@bastion-mcp/auth';
import {
  createPluginsHandler,
  type MarketplaceRow,
  type PluginAccess,
  type PluginPrincipal,
  toNodeListener,
} from '@bastion-mcp/plugins';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { marketplaceVisibleTo } from '../../adapters/plugin-access';
import { createPluginServices } from '../../adapters/plugin-services';
import type { AuthServices } from '../../contracts';
import type { Infra } from '../../infra';

export type PluginRoutesDeps = { infra: Infra; auth: AuthServices };

type VerifiedPluginPrincipal = PluginPrincipal & { principal?: Principal };

/**
 * `PluginAccess` over the token verifier: the secret is a PAT or an OAuth access token (the `bastion-credential`
 * helper and Claude's git credential flow send it as the Basic password or as a Bearer token, 25.6). The verifier
 * enforces `plugins:read` and revocation; an `InsufficientScopeError` becomes a principal without the scope so the
 * handler answers 403 (`scope plugins:read required`) rather than 401.
 */
export const createPluginAccess = ({ infra, auth }: PluginRoutesDeps): PluginAccess => ({
  async authenticate(secret) {
    try {
      const principal = await auth.verifier.verify(
        `Bearer ${secret}`,
        `${infra.config.publicUrl}/plugins/marketplace`,
      );
      return {
        id: principal.id,
        scopes: principal.scopes,
        principal,
      } satisfies VerifiedPluginPrincipal;
    } catch (error) {
      if (error instanceof InsufficientScopeError) return { id: 'unauthorized', scopes: [] };
      if (error instanceof AuthenticationError) return undefined;
      throw error;
    }
  },
  async canView(principal, marketplace: MarketplaceRow) {
    const viewer = (principal as VerifiedPluginPrincipal).principal;
    if (!viewer) return false;
    const row = await infra.db.prisma.marketplace.findUnique({
      where: { id: marketplace.id },
      select: { audience: true, ownerTeamId: true },
    });
    return row ? marketplaceVisibleTo(row, viewer) : false;
  },
});

/** Mounts `/plugins/*` (git smart HTTP read-only, `marketplace.json`, `archives/*.zip`); everything is Cedar-free: visibility is the marketplace audience. */
export const registerPluginRoutes = async (
  app: FastifyInstance,
  deps: PluginRoutesDeps,
): Promise<void> => {
  const { infra } = deps;
  const services = createPluginServices(infra);
  const handler = createPluginsHandler({
    host: services.baseUrl,
    access: createPluginAccess(deps),
    marketplaces: services.marketplaces,
    releases: services.releases,
    releaseService: services.releaseService,
    repositories: services.repositories,
    events: services.events,
  });
  const listener = toNodeListener(handler, { origin: infra.config.publicUrl });

  await app.register(async (scope) => {
    // Bodies (git upload-pack requests, possibly gzip) are streamed to the handler untouched.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    const serve = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      listener(req.raw, reply.raw);
    };
    scope.all('/plugins/*', serve);
  });
};
