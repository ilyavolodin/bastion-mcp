/**
 * The embedded authorization server (9.3) mounted at `/oauth` and `/.well-known/oauth-authorization-server/oauth`,
 * plus its login and consent pages (`/oauth/interaction/:uid`). The AS is a Node request listener: bodies reach it
 * untouched (pass-through content-type parser) and the response is written by it after `reply.hijack()`.
 */
import { clearSessionCookies, SESSION_COOKIE } from '@bastion-mcp/auth';
import type { FastifyInstance } from 'fastify';
import { type AccountView, accountChooserPage, consentPage } from '../pages/templates';
import { sendLoginPage } from './login';
import {
  addCookie,
  cookiesSecure,
  cookieValue,
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

/**
 * Set when this request showed the sign-in page: the interaction then returns signed in, and the person who has just
 * signed in is not asked which account again. Names the interaction, so it cannot carry over to another request.
 */
const INTERACTION_COOKIE = 'bastion_ia';
const INTERACTION_COOKIE_MAX_AGE = 600;

const interactionCookie = (value: string, maxAge: number, secure: boolean): string =>
  [
    `${INTERACTION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/oauth/interaction',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');

/** Login and consent pages of the AS interactions (9.3). */
export const registerInteractionPages = async (app: FastifyInstance, deps: UiDeps) => {
  const { auth } = deps;
  const interactions = auth.authorizationServer.interactions;

  /** How the pages name an account: its display name and e-mail. */
  const accountOf = async (userId: string): Promise<AccountView | null> => {
    const user = await deps.infra.repos.users.get(userId);
    return user ? { name: user.displayName || user.email, email: user.email } : null;
  };

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
      const principal = await sessionPrincipal(deps, req);
      const account = principal?.type === 'user' ? await accountOf(principal.id) : null;
      if (view.kind === 'login') {
        // A browser that was already signed in when the app asked does not silently authorize the app as that
        // account: the person confirms it or signs in as somebody else (an admin session left in the browser must
        // not become the identity of a member's Claude). A person who signed in during THIS request, which our
        // marker cookie says, has just chosen the account and goes straight on.
        const justSignedIn = cookieValue(req, INTERACTION_COOKIE) === view.uid;
        if (account && justSignedIn) {
          hijack(reply);
          await interactions.completeLogin(req.raw, reply.raw, { userId: principal?.id ?? '' });
          return;
        }
        if (account) {
          return sendHtml(
            reply,
            200,
            accountChooserPage({
              uid: view.uid,
              csrf: ensureCsrf(deps, req, reply),
              clientId: view.clientId,
              account,
            }),
          );
        }
        addCookie(
          reply,
          interactionCookie(view.uid, INTERACTION_COOKIE_MAX_AGE, cookiesSecure(deps.infra)),
        );
        return sendLoginPage(deps, req, reply, {
          returnTo: `/oauth/interaction/${view.uid}`,
          forClient: view.clientId,
        });
      }
      if (!account) {
        return errorPage(reply, 400, 'Your sign-in expired. Start again from your client.');
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
          account,
        }),
      );
    });

    // The signed-in account is confirmed: the interaction continues as that account.
    scope.post<{ Params: { uid: string }; Body: FormBody }>(
      '/oauth/interaction/:uid/continue',
      async (req, reply) => {
        if (!formCsrfOk(req, req.body?._csrf)) {
          return errorPage(reply, 403, 'The form expired. Reload the page and try again.');
        }
        const principal = await sessionPrincipal(deps, req);
        if (principal?.type !== 'user') {
          return errorPage(reply, 400, 'Your sign-in expired. Start again from your client.');
        }
        try {
          const view = await interactions.view(req.raw, reply.raw);
          if (view.kind !== 'login') {
            return errorPage(reply, 400, 'This request is not waiting for sign-in.');
          }
        } catch {
          return errorPage(
            reply,
            400,
            'This sign-in request has expired. Start again from your client.',
          );
        }
        hijack(reply);
        await interactions.completeLogin(req.raw, reply.raw, { userId: principal.id });
      },
    );

    // The person is somebody else: end this browser's session and sign in again, then continue the same request.
    scope.post<{ Params: { uid: string }; Body: FormBody }>(
      '/oauth/interaction/:uid/switch',
      async (req, reply) => {
        if (!formCsrfOk(req, req.body?._csrf)) {
          return errorPage(reply, 403, 'The form expired. Reload the page and try again.');
        }
        // Both sessions go: Bastion's own, and the authorization server's (which would otherwise treat the next
        // sign-in as a different account on top of this one). The request that was pending starts again and, with
        // nobody signed in, asks for a sign-in first.
        let restart: string;
        try {
          restart = await interactions.endSession(req.raw, reply.raw);
        } catch {
          return errorPage(
            reply,
            400,
            'This sign-in request has expired. Start again from your client.',
          );
        }
        const sid = cookieValue(req, SESSION_COOKIE);
        if (sid) await auth.sessions.destroy(sid);
        for (const cookie of clearSessionCookies({ secure: cookiesSecure(deps.infra) })) {
          addCookie(reply, cookie);
        }
        return reply.header('cache-control', 'no-store').redirect(`/oauth/auth?${restart}`, 303);
      },
    );

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
