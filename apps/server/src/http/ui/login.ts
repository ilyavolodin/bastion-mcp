/** Browser login (9.1, 9.2): IdP login and callback, break-glass local login, logout. */
import {
  assertCsrf,
  CSRF_HEADER,
  clearSessionCookies,
  IdpClaimError,
  IdpLoginError,
  localLoginEnabled,
  OAuthProtocolError,
  ProvisioningDeniedError,
  type ProvisioningEvent,
  planLogin,
  routeByEmail,
  SESSION_COOKIE,
  verifyLocalLogin,
} from '@bastion-mcp/auth';
import { BastionError, newId } from '@bastion-mcp/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  addCookie,
  allowAttempt,
  cookiesSecure,
  cookieValue,
  ensureCsrf,
  errorPage,
  esc,
  formCsrfOk,
  layout,
  safeReturnTo,
  sendHtml,
  startSession,
  type UiDeps,
} from './util';

const STATE_COOKIE = 'bastion_login';
const STATE_COOKIE_MAX_AGE = 600;
const LOCAL_LOGIN_MAX = 10;
const LOCAL_LOGIN_WINDOW_S = 300;

export type LoginOptions = {
  /** Receives the events of a provisioning plan (user.created, team.member_added...) to run auto-install (11.5). */
  onProvisioned?: (events: readonly ProvisioningEvent[]) => Promise<void> | void;
};

type Query = Record<string, string | undefined>;
type FormBody = Record<string, string | undefined>;

const stateCookie = (value: string, maxAge: number, secure: boolean): string =>
  [
    `${STATE_COOKIE}=${value}`,
    'Path=/auth/callback',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');

export const registerLoginRoutes = async (
  app: FastifyInstance,
  deps: UiDeps,
  options: LoginOptions = {},
) => {
  const { infra, auth } = deps;
  const { repos, logger } = infra;
  const secure = cookiesSecure(infra);

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    const loginPage = async (
      req: FastifyRequest,
      reply: FastifyReply,
      returnTo: string,
      message?: string,
    ) => {
      const connections = (await repos.idpConnections.list()).filter((c) => c.enabled);
      const local = localLoginEnabled({
        idpConnectionCount: connections.length,
        localLoginFlag: infra.config.localLogin,
      });
      const back = encodeURIComponent(returnTo);
      const links = connections
        .map(
          (c) =>
            `<a class="button" href="/auth/login?connection=${esc(encodeURIComponent(c.id))}&amp;return_to=${back}">Continue with ${esc(c.name)}</a>`,
        )
        .join('');
      const emailForm =
        connections.length > 1
          ? `<form method="get" action="/auth/login"><input type="hidden" name="return_to" value="${esc(returnTo)}"><label>Work email<input type="email" name="email" autocomplete="username"></label><button type="submit">Continue</button></form>`
          : '';
      const csrf = ensureCsrf(deps, req, reply);
      const form = local
        ? `<form method="post" action="/auth/local"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><label>Email<input type="email" name="email" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button class="primary" type="submit">Sign in</button></form>`
        : '';
      const note = message ? `<p class="error">${esc(message)}</p>` : '';
      const empty =
        connections.length === 0 && !local
          ? '<p class="muted">No sign-in method is configured.</p>'
          : '';
      return sendHtml(
        reply,
        message ? 401 : 200,
        layout('Sign in to Bastion', `${note}${links}${emailForm}${form}${empty}`),
      );
    };

    // --- /auth/login ---------------------------------------------------------------------------------------
    scope.get<{ Querystring: Query }>('/auth/login', async (req, reply) => {
      const q = req.query;
      const returnTo = safeReturnTo(q.return_to ?? q.returnTo);
      const connections = (await repos.idpConnections.list()).filter((c) => c.enabled);
      let connectionId = q.connection;
      if (!connectionId && q.email) connectionId = routeByEmail(connections, q.email)?.id;
      if (
        !connectionId &&
        connections.length === 1 &&
        !localLoginEnabled({
          idpConnectionCount: connections.length,
          localLoginFlag: infra.config.localLogin,
        })
      ) {
        connectionId = connections[0]?.id;
      }
      if (!connectionId) return loginPage(req, reply, returnTo);
      try {
        const started = await auth.idpLogin.startLogin(connectionId, {
          returnTo,
          ...(q.email ? { loginHint: q.email } : {}),
        });
        addCookie(reply, stateCookie(started.stateToken, STATE_COOKIE_MAX_AGE, secure));
        return reply.header('cache-control', 'no-store').redirect(started.authorizationUrl, 302);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'idp login start failed',
        );
        return errorPage(reply, 400, 'This identity provider is not available.');
      }
    });

    // --- /auth/callback/:idpConnectionId ----------------------------------------------------------------
    scope.get<{ Params: { idpConnectionId: string } }>(
      '/auth/callback/:idpConnectionId',
      async (req, reply) => {
        const { idpConnectionId } = req.params;
        const state = cookieValue(req, STATE_COOKIE);
        addCookie(reply, stateCookie('', 0, secure));
        if (!state) return errorPage(reply, 400, 'The sign-in session expired. Try again.');
        const query = req.raw.url?.split('?')[1] ?? '';
        try {
          const result = await auth.idpLogin.completeLogin(idpConnectionId, query, state);
          const { connection, profile, tokens } = result;
          const existingId = await repos.scim?.findUserIdByEmail(profile.email);
          const existing = existingId ? await repos.scim?.getUserState(existingId) : null;
          const plan = planLogin({
            connection,
            claims: {
              sub: profile.sub,
              email: profile.email,
              displayName: profile.name,
              groups: profile.groups,
            },
            existingUser: existing ?? null,
            rules: (await repos.scim?.listRules(connection.id)) ?? [],
            teams: (await repos.scim?.listTeamRefs()) ?? [],
            now: new Date(),
            newId: () => newId(),
          });
          await repos.provisioning.applyPlan(plan, { actorType: 'system' });
          const userId = plan.user.id;
          if (plan.user.kind === 'create') await repos.users.recordLogin(userId, new Date());
          if (connection.storeRefreshToken || tokens.refreshToken) {
            await auth.idpTokens.save(userId, connection.id, tokens);
          }
          if (options.onProvisioned && plan.events.length > 0) {
            try {
              await options.onProvisioned(plan.events);
            } catch (error) {
              logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                'provisioning hook failed',
              );
            }
          }
          await startSession(deps, reply, userId);
          return reply
            .header('cache-control', 'no-store')
            .redirect(safeReturnTo(result.returnTo), 302);
        } catch (error) {
          if (error instanceof ProvisioningDeniedError) {
            return errorPage(reply, 403, `Sign-in was refused: ${error.message}.`);
          }
          if (
            error instanceof IdpLoginError ||
            error instanceof IdpClaimError ||
            error instanceof OAuthProtocolError ||
            error instanceof BastionError
          ) {
            logger.warn({ err: error.message }, 'idp login failed');
            return errorPage(
              reply,
              400,
              'Sign-in failed. Try again or contact your administrator.',
            );
          }
          throw error;
        }
      },
    );

    // --- /auth/local (break-glass, 9.1) -----------------------------------------------------------------
    scope.post<{ Body: FormBody }>('/auth/local', async (req, reply) => {
      const body = (req.body ?? {}) as FormBody;
      const returnTo = safeReturnTo(body.return_to);
      const json = req.headers['content-type']?.includes('application/json') === true;
      if (!json && !formCsrfOk(req, body._csrf)) {
        return errorPage(reply, 403, 'The form expired. Reload the page and try again.');
      }
      const email = (body.email ?? '').trim().toLowerCase();
      const ok =
        (await allowAttempt(infra, `local:ip:${req.ip}`, LOCAL_LOGIN_MAX, LOCAL_LOGIN_WINDOW_S)) &&
        (await allowAttempt(infra, `local:email:${email}`, LOCAL_LOGIN_MAX, LOCAL_LOGIN_WINDOW_S));
      if (!ok) {
        return reply
          .code(429)
          .header('retry-after', String(LOCAL_LOGIN_WINDOW_S))
          .send({ error: 'too_many_attempts' });
      }
      const user = await verifyLocalLogin(
        { users: repos.localAdmins },
        {
          idpConnectionCount: await repos.idpConnections.count(),
          localLoginFlag: infra.config.localLogin,
        },
        email,
        body.password ?? '',
      );
      if (!user) {
        if (json) return reply.code(401).send({ error: 'invalid_credentials' });
        return loginPage(req, reply, returnTo, 'Invalid email or password.');
      }
      await repos.users.recordLogin(user.id, new Date());
      await startSession(deps, reply, user.id);
      if (json) return reply.code(204).send();
      return reply.header('cache-control', 'no-store').redirect(returnTo, 303);
    });

    // --- /auth/logout (SPA: header double submit) --------------------------------------------------------------
    scope.post('/auth/logout', async (req, reply) => {
      try {
        assertCsrf(req.headers.cookie, req.headers[CSRF_HEADER] as string | undefined);
      } catch {
        return reply.code(403).send({ error: 'csrf' });
      }
      const sid = cookieValue(req, SESSION_COOKIE);
      if (sid) await auth.sessions.destroy(sid);
      for (const cookie of clearSessionCookies({ secure })) addCookie(reply, cookie);
      return reply.code(204).send();
    });
  });
};
