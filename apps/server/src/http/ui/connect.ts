/** Per-user upstream OAuth pages and documents (9.6): /connect, the callback, client metadata and JWKS. */
import {
  buildUpstreamClientMetadata,
  buildUpstreamJwksDocument,
  buildUpstreamPublicClientMetadata,
  OAuthProtocolError,
  UpstreamClientError,
  UpstreamDiscoveryError,
  UpstreamStateError,
} from '@bastion-mcp/auth';
import type { FastifyInstance } from 'fastify';
import { createInstallationLookup } from '../../adapters/auth';
import { connectPage } from '../pages/templates';
import { ensureCsrf, errorPage, formCsrfOk, sendHtml, sessionPrincipal, type UiDeps } from './util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { installationId: string };

export const registerConnectRoutes = async (app: FastifyInstance, deps: UiDeps) => {
  const { infra, auth } = deps;
  const { logger } = infra;
  const lookup = createInstallationLookup(infra);
  // The auth URL builders take the public origin (scheme included), not a bare host.
  const host = new URL(infra.config.publicUrl).origin;

  /** The installation's owner or a member of the owning team may connect their own account (9.6). */
  const mayConnect = async (installationId: string, userId: string, teams: readonly string[]) => {
    const row = await infra.db.prisma.installation.findUnique({
      where: { id: installationId },
      select: { ownerType: true, ownerId: true },
    });
    if (!row) return false;
    if (row.ownerType === 'user') return row.ownerId === userId;
    if (row.ownerType === 'team') return teams.includes(row.ownerId);
    return false;
  };

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    // --- documents the upstream AS fetches (public, cacheable) ----------------------------------------------
    scope.get('/oauth/upstream/client-metadata.json', async (_req, reply) => {
      const settings = await infra.repos.orgSettings.getAll();
      return reply
        .header('cache-control', 'public, max-age=300')
        .header('access-control-allow-origin', '*')
        .type('application/json')
        .send(buildUpstreamClientMetadata({ host, orgName: settings.org.displayName }));
    });
    scope.get('/oauth/upstream/client-metadata-public.json', async (_req, reply) => {
      const settings = await infra.repos.orgSettings.getAll();
      return reply
        .header('cache-control', 'public, max-age=300')
        .header('access-control-allow-origin', '*')
        .type('application/json')
        .send(buildUpstreamPublicClientMetadata({ host, orgName: settings.org.displayName }));
    });
    scope.get('/oauth/upstream/jwks', async (_req, reply) =>
      reply
        .header('cache-control', 'public, max-age=300')
        .header('access-control-allow-origin', '*')
        .type('application/json')
        .send(await buildUpstreamJwksDocument(auth.keyStore, new Date())),
    );

    // --- /connect/:installationId -----------------------------------------------------------------------------
    scope.get<{ Params: Params }>('/connect/:installationId', async (req, reply) => {
      const principal = await sessionPrincipal(deps, req);
      if (!principal) {
        return reply.redirect(`/auth/login?return_to=${encodeURIComponent(req.url)}`, 302);
      }
      const { installationId } = req.params;
      if (!UUID.test(installationId)) return errorPage(reply, 404, 'Unknown server.');
      const teams = principal.teams.map((t) => t.teamId);
      const installation = await lookup.get(installationId);
      if (!installation || !(await mayConnect(installationId, principal.id, teams))) {
        return errorPage(reply, 404, 'This server cannot be connected with your account.');
      }
      try {
        const model = await auth.broker.connectPage(installation);
        return sendHtml(
          reply,
          200,
          connectPage({
            installationId,
            installationName: model.installationName,
            authorizationServerHost: model.authorizationServerHost,
            scopes: model.scopes,
            csrf: ensureCsrf(deps, req, reply),
          }),
        );
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'connect page failed',
        );
        return errorPage(reply, 502, 'The server’s sign-in service could not be reached.');
      }
    });

    scope.post<{ Params: Params; Body: Record<string, string | undefined> }>(
      '/connect/:installationId',
      async (req, reply) => {
        const principal = await sessionPrincipal(deps, req);
        if (!principal) return reply.redirect('/auth/login', 302);
        if (!formCsrfOk(req, req.body?._csrf)) {
          return errorPage(reply, 403, 'The form expired. Reload the page and try again.');
        }
        const { installationId } = req.params;
        const installation = UUID.test(installationId) ? await lookup.get(installationId) : null;
        if (
          !installation ||
          !(await mayConnect(
            installationId,
            principal.id,
            principal.teams.map((t) => t.teamId),
          ))
        ) {
          return errorPage(reply, 404, 'This server cannot be connected with your account.');
        }
        try {
          const { authorizationUrl } = await auth.broker.startAuthorization(
            { type: principal.type, id: principal.id },
            installation,
          );
          return reply.header('cache-control', 'no-store').redirect(authorizationUrl, 303);
        } catch (error) {
          return upstreamFailure(reply, error);
        }
      },
    );

    // --- /oauth/upstream/callback ----------------------------------------------------------------------------
    scope.get('/oauth/upstream/callback', async (req, reply) => {
      const principal = await sessionPrincipal(deps, req);
      if (!principal) {
        return reply.redirect(`/auth/login?return_to=${encodeURIComponent(req.url)}`, 302);
      }
      const query = req.raw.url?.split('?')[1] ?? '';
      try {
        const done = await auth.broker.completeAuthorization(
          { type: principal.type, id: principal.id },
          query,
        );
        // The hidden installation of a catalog test has no page of its own: back to the editor's Test step.
        const row = await infra.db.prisma.installation.findUnique({
          where: { id: done.installationId },
          select: { origin: true, catalogEntryId: true },
        });
        const target =
          row?.origin === 'test' && row.catalogEntryId
            ? `/catalog/${encodeURIComponent(row.catalogEntryId)}?step=test&run=1`
            : `/servers/${encodeURIComponent(done.installationId)}?connected=1`;
        return reply.header('cache-control', 'no-store').redirect(target, 302);
      } catch (error) {
        return upstreamFailure(reply, error);
      }
    });

    const upstreamFailure = (reply: Parameters<typeof errorPage>[0], error: unknown) => {
      if (
        error instanceof OAuthProtocolError ||
        error instanceof UpstreamStateError ||
        error instanceof UpstreamDiscoveryError ||
        error instanceof UpstreamClientError
      ) {
        logger.warn({ err: error.message }, 'upstream oauth failed');
        return errorPage(
          reply,
          400,
          'Connecting your account failed. Start again from the server page.',
        );
      }
      throw error;
    };
  });
};
