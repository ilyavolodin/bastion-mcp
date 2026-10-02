/**
 * The embedded authorization server (9.3) mounted at `/oauth` and `/.well-known/oauth-authorization-server/oauth`,
 * plus its login and consent pages (`/oauth/interaction/:uid`). The AS is a Node request listener: bodies reach it
 * untouched (pass-through content-type parser) and the response is written by it after `reply.hijack()`.
 */
import type { FastifyInstance } from 'fastify';
import { consentPage } from '../pages/templates';
import { sendLoginPage } from './login';
import {
  ensureCsrf,
  errorPage,
  formCsrfOk,
  hijack,
  PAGE_CSP,
  sendHtml,
  sessionPrincipal,
  type UiDeps,
} from './util';

const CORS_PATHS = [
  '/.well-known/',
  '/oauth/.well-known/',
  '/oauth/token',
  '/oauth/reg',
  '/oauth/jwks',
  '/oauth/device',
  '/oauth/token/revocation',
];

const needsCors = (path: string): boolean => CORS_PATHS.some((p) => path.startsWith(p));

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Raw AS endpoints: well-known, token, registration, authorization, device, jwks, revocation. */
export const registerAuthorizationServer = async (app: FastifyInstance, deps: UiDeps) => {
  const { auth } = deps;
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    const handler = async (
      req: Parameters<Parameters<typeof scope.route>[0]['handler']>[0],
      reply: Parameters<Parameters<typeof scope.route>[0]['handler']>[1],
    ) => {
      const path = req.raw.url?.split('?')[0] ?? '';
      if (needsCors(path)) {
        reply.header('access-control-allow-origin', '*');
        if (req.method === 'OPTIONS') {
          return reply
            .code(204)
            .header('access-control-allow-methods', 'GET, POST, OPTIONS')
            .header(
              'access-control-allow-headers',
              'content-type, authorization, mcp-protocol-version',
            )
            .header('access-control-max-age', '600')
            .send();
        }
      }
      // Pages rendered by the provider (device flow, errors) get the strict page CSP, not the SPA's.
      reply.header('content-security-policy', PAGE_CSP);
      hijack(reply);
      await auth.authorizationServer.listener(req.raw, reply.raw);
    };
    for (const url of ['/oauth', '/oauth/*', '/.well-known/oauth-authorization-server/oauth']) {
      scope.route({ method: [...METHODS], url, handler });
    }
  });
};

type FormBody = Record<string, string | undefined>;

/** Login and consent pages of the AS interactions (9.3). */
export const registerInteractionPages = async (app: FastifyInstance, deps: UiDeps) => {
  const { auth } = deps;
  const interactions = auth.authorizationServer.interactions;

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    scope.get<{ Params: { uid: string } }>('/oauth/interaction/:uid', async (req, reply) => {
      let view: Awaited<ReturnType<typeof interactions.view>>;
      try {
        view = await interactions.view(req.raw, reply.raw);
      } catch {
        return errorPage(
          reply,
          400,
          'This sign-in request has expired. Start again from your client.',
          { title: 'Request expired', back: { href: '/', label: 'Back to Bastion' } },
        );
      }
      if (view.kind === 'login') {
        const principal = await sessionPrincipal(deps, req);
        if (principal && principal.type === 'user') {
          hijack(reply);
          await interactions.completeLogin(req.raw, reply.raw, { userId: principal.id });
          return;
        }
        return sendLoginPage(deps, req, reply, {
          returnTo: `/oauth/interaction/${view.uid}`,
          forClient: view.clientId,
        });
      }
      const c = view.consent;
      return sendHtml(
        reply,
        200,
        consentPage({
          uid: view.uid,
          csrf: ensureCsrf(deps, req, reply),
          clientName: c.clientName,
          logoUri: c.logoUri,
          redirectHost: c.redirectUriHost,
          scopes: c.scopes,
        }),
      );
    });

    scope.post<{ Params: { uid: string }; Body: FormBody }>(
      '/oauth/interaction/:uid/consent',
      async (req, reply) => {
        const body = req.body ?? {};
        if (!formCsrfOk(req, body._csrf))
          return errorPage(reply, 403, 'The form expired. Reload the page and try again.');
        try {
          const view = await interactions.view(req.raw, reply.raw);
          if (view.kind !== 'consent') {
            return errorPage(reply, 400, 'This request is not waiting for consent.');
          }
        } catch {
          return errorPage(
            reply,
            400,
            'This sign-in request has expired. Start again from your client.',
          );
        }
        hijack(reply);
        if (body.decision === 'approve') await interactions.completeConsent(req.raw, reply.raw);
        else await interactions.denyConsent(req.raw, reply.raw);
      },
    );
  });
};
