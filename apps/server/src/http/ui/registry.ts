/** Bastion as a subregistry (11.8): `/registry/v0.1/*` lists the caller's endpoints in the official MCP Registry shape. */
import { AuthenticationError, InsufficientScopeError, type Principal } from '@bastion-mcp/auth';
import { effectiveTeamSlug } from '@bastion-mcp/core';
import { createRouterRepository } from '@bastion-mcp/db';
import { type OverridesDocument, overridesSchema } from '@bastion-mcp/overrides';
import {
  getSubregistryVersion,
  getSubregistryVersions,
  listSubregistryServers,
  type SubregistryInput,
} from '@bastion-mcp/registry';
import type { InstallationInfo } from '@bastion-mcp/router';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthServices } from '../../contracts';
import type { Infra } from '../../infra';

export type SubregistryRoutesDeps = { infra: Infra; auth: AuthServices };

/** `api:read` is verified against the `/api` resource: `/registry` is part of the management API surface (11.8, 9.3). */
const verifyApiRead = async (
  { infra, auth }: SubregistryRoutesDeps,
  req: FastifyRequest,
): Promise<Principal> =>
  auth.verifier.verify(req.headers.authorization, `${infra.config.publicUrl}/api/registry/v0.1`);

const deny = (reply: FastifyReply, error: unknown): FastifyReply | undefined => {
  if (error instanceof AuthenticationError || error instanceof InsufficientScopeError) {
    return reply
      .code(error.httpStatus)
      .header('www-authenticate', error.wwwAuthenticate)
      .send({ error: error.message });
  }
  return undefined;
};

/**
 * `GET /registry/v0.1/servers`, `/servers/{name}/versions` and `/servers/{name}/versions/{version}`, authenticated with
 * a PAT or OAuth token carrying `api:read`. One entry for the default endpoint and one per installation the caller can
 * use, each with a `streamable-http` remote at `/mcp` or `/mcp/i/{slug}`.
 */
export const registerSubregistryRoutes = async (
  app: FastifyInstance,
  deps: SubregistryRoutesDeps,
): Promise<void> => {
  const { infra } = deps;
  const router = createRouterRepository<OverridesDocument>(infra.db.prisma, {
    parseOverrides: (raw) => overridesSchema.parse(raw),
  });
  const host = new URL(infra.config.publicUrl).host;
  const scheme = new URL(infra.config.publicUrl).protocol === 'http:' ? 'http' : 'https';

  const inputFor = async (principal: Principal): Promise<SubregistryInput> => {
    const rows = (await router.listForPrincipal({
      id: principal.id,
      type: principal.type,
      teamIds: principal.teams.map((t) => t.teamId),
    })) as unknown as InstallationInfo[];
    const settings = await infra.repos.orgSettings.getAll();
    const timestamps = await infra.db.prisma.installation.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    const byId = new Map(timestamps.map((t) => [t.id, t]));
    return {
      host,
      scheme,
      defaultEndpointTitle: `${settings.org.displayName} default endpoint`,
      installations: rows
        .filter((r) => r.enabled)
        .map((r) => ({
          installationId: r.id,
          slug: r.owner.kind === 'team' ? effectiveTeamSlug(r.owner.slug, r.slug) : r.slug,
          displayName: r.displayName,
          ...(r.catalogEntryId === r.id ? {} : { catalogEntryId: r.catalogEntryId }),
          ...(byId.get(r.id)?.createdAt ? { createdAt: byId.get(r.id)?.createdAt as Date } : {}),
          ...(byId.get(r.id)?.updatedAt ? { updatedAt: byId.get(r.id)?.updatedAt as Date } : {}),
          enabled: r.enabled,
        })),
    };
  };

  await app.register(async (scope) => {
    scope.get<{ Querystring: { limit?: string; cursor?: string; search?: string } }>(
      '/registry/v0.1/servers',
      async (req, reply) => {
        try {
          const principal = await verifyApiRead(deps, req);
          const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;
          return reply.header('cache-control', 'private, no-store').send(
            listSubregistryServers(await inputFor(principal), {
              ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
              ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
              ...(req.query.search ? { search: req.query.search } : {}),
            }),
          );
        } catch (error) {
          const denied = deny(reply, error);
          if (denied) return denied;
          throw error;
        }
      },
    );

    scope.get<{ Params: { name: string } }>(
      '/registry/v0.1/servers/:name/versions',
      async (req, reply) => {
        try {
          const principal = await verifyApiRead(deps, req);
          const list = getSubregistryVersions(await inputFor(principal), req.params.name);
          return list
            ? reply.header('cache-control', 'private, no-store').send(list)
            : reply.code(404).send({ error: 'server not found' });
        } catch (error) {
          const denied = deny(reply, error);
          if (denied) return denied;
          throw error;
        }
      },
    );

    scope.get<{ Params: { name: string; version: string } }>(
      '/registry/v0.1/servers/:name/versions/:version',
      async (req, reply) => {
        try {
          const principal = await verifyApiRead(deps, req);
          const entry = getSubregistryVersion(
            await inputFor(principal),
            req.params.name,
            req.params.version,
          );
          return entry
            ? reply.header('cache-control', 'private, no-store').send(entry)
            : reply.code(404).send({ error: 'server version not found' });
        } catch (error) {
          const denied = deny(reply, error);
          if (denied) return denied;
          throw error;
        }
      },
    );
  });
};
