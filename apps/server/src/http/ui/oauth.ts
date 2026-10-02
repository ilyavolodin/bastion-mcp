/**
 * The embedded authorization server (9.3) mounted at `/oauth` and `/.well-known/oauth-authorization-server/oauth`,
 * plus its login and consent pages (`/oauth/interaction/:uid`). The AS is a Node request listener: bodies reach it
 * untouched (pass-through content-type parser) and the response is written by it after `reply.hijack()`.
 */
import { localLoginEnabled } from '@bastion-mcp/auth';
import type { FastifyInstance } from 'fastify';
import {
  ensureCsrf,
  errorPage,
  esc,
  formCsrfOk,
  hijack,
  layout,
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
  const { auth, infra } = deps;
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
        );
      }
      if (view.kind === 'login') {
        const principal = await sessionPrincipal(deps, req);
        if (principal && principal.type === 'user') {
          hijack(reply);
          await interactions.completeLogin(req.raw, reply.raw, { userId: principal.id });
          return;
        }
        const connections = (await infra.repos.idpConnections.list()).filter((c) => c.enabled);
        const local = localLoginEnabled({
          idpConnectionCount: connections.length,
          localLoginFlag: infra.config.localLogin,
        });
        const back = encodeURIComponent(`/oauth/interaction/${view.uid}`);
        const links = connections
          .map(
            (c) =>
              `<a class="button" href="/auth/login?connection=${esc(encodeURIComponent(c.id))}&amp;return_to=${back}">Continue with ${esc(c.name)}</a>`,
          )
          .join('');
        const csrf = ensureCsrf(deps, req, reply);
        const form = local
          ? `<form method="post" action="/auth/local"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="return_to" value="/oauth/interaction/${esc(view.uid)}"><label>Email<input type="email" name="email" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button class="primary" type="submit">Sign in</button></form>`
          : '';
        return sendHtml(
          reply,
          200,
          layout(
            'Sign in',
            `<p class="muted">Sign in to continue to <code>${esc(view.clientId)}</code>.</p>${links}${form}`,
          ),
        );
      }
      const c = view.consent;
      const csrf = ensureCsrf(deps, req, reply);
      const scopes = c.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join('');
      const logo = c.logoUri ? `<img src="${esc(c.logoUri)}" alt="" width="48" height="48">` : '';
      return sendHtml(
        reply,
        200,
        layout(
          'Authorize access',
          `${logo}<p><strong>${esc(c.clientName)}</strong> wants to access your Bastion account.</p><p class="muted">After you decide you will be sent to <strong>${esc(c.redirectUriHost)}</strong>.</p><p>It is asking for:</p><ul>${scopes}</ul><form method="post" action="/oauth/interaction/${esc(view.uid)}/consent"><input type="hidden" name="_csrf" value="${esc(csrf)}"><div class="row"><button class="primary" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div></form>`,
        ),
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
