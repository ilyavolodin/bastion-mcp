/** Browser login (9.1, 9.2): IdP login and callback, break-glass local login, forgot-password page, logout. */
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
  forgotPasswordPage,
  type PageMessage,
  loginPage as renderLoginPage,
} from '../pages/templates';
import { ACCOUNT_RULE, clearFailures, loginBlockedFor, recordLoginFailure } from './throttle';
import {
  addCookie,
  cookiesSecure,
  cookieValue,
  ensureCsrf,
  errorPage,
  formCsrfOk,
  safeReturnTo,
  sendHtml,
  startSession,
  type UiDeps,
} from './util';

const STATE_COOKIE = 'bastion_login';
const STATE_COOKIE_MAX_AGE = 600;
const MAX_EMAIL_LENGTH = 254;
const BACK_TO_SIGN_IN = { href: '/auth/login', label: 'Back to sign in' };

export type LoginOptions = {
  /** Receives the events of a provisioning plan (user.created, team.member_added...) to run auto-install (11.5). */
  onProvisioned?: (events: readonly ProvisioningEvent[]) => Promise<void> | void;
};

type Query = Record<string, string | undefined>;
type FormBody = Record<string, string | undefined>;

const STATE_PATH = '/auth/callback';
/** The state cookie of a root-redirect connection is `{connection id}~{state token}`, sent to every path. */
const STATE_ID_SEPARATOR = '~';

const stateCookie = (
  value: string,
  maxAge: number,
  secure: boolean,
  path: string = STATE_PATH,
): string =>
  [
    `${STATE_COOKIE}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');

/** What the sign-in page offers (9.1): the enabled IdPs and whether local password login is on. */
export const loadSignInOptions = async (infra: UiDeps['infra']) => {
  const all = await infra.repos.idpConnections.list();
  const connections = all.filter((c) => c.enabled);
  // 9.1: local login is on while "no IdP connection exists", so even a disabled connection switches it off.
  const localEnabled = localLoginEnabled({
    idpConnectionCount: all.length,
    localLoginFlag: infra.config.localLogin,
  });
  return { connections, localEnabled, idpCount: all.length };
};

/** Renders the sign-in page for the browser login and for the authorization server's login interaction. */
export const sendLoginPage = async (
  deps: UiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  input: {
    returnTo: string;
    status?: number;
    message?: PageMessage;
    email?: string;
    forClient?: string;
  },
): Promise<FastifyReply> => {
  const { connections, localEnabled } = await loadSignInOptions(deps.infra);
  const csrf = ensureCsrf(deps, req, reply);
  return sendHtml(
    reply,
    input.status ?? 200,
    renderLoginPage({
      returnTo: input.returnTo,
      connections: connections.map((c) => ({ id: c.id, name: c.name })),
      local: { enabled: localEnabled, csrf, email: input.email },
      message: input.message,
      forClient: input.forClient,
    }),
  );
};

export const registerLoginRoutes = async (
  app: FastifyInstance,
  deps: UiDeps,
  options: LoginOptions = {},
) => {
  const { infra, auth } = deps;
  const { repos, logger } = infra;
  const secure = cookiesSecure(infra);

  /** Completes an IdP sign-in: the IdP returned to `/auth/callback/{id}` or, for a root-redirect connection, to `/`. */
  const finishLogin = async (
    req: FastifyRequest,
    reply: FastifyReply,
    idpConnectionId: string,
    state: string | undefined,
    cookiePath: string,
  ) => {
    addCookie(reply, stateCookie('', 0, secure, cookiePath));
    if (!state) {
      return errorPage(reply, 400, 'The sign-in session expired. Try again.', {
        back: BACK_TO_SIGN_IN,
      });
    }
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
      return reply.header('cache-control', 'no-store').redirect(safeReturnTo(result.returnTo), 302);
    } catch (error) {
      if (error instanceof ProvisioningDeniedError) {
        return errorPage(reply, 403, `Sign-in was refused: ${error.message}.`, {
          back: BACK_TO_SIGN_IN,
        });
      }
      if (
        error instanceof IdpLoginError ||
        error instanceof IdpClaimError ||
        error instanceof OAuthProtocolError ||
        error instanceof BastionError
      ) {
        logger.warn({ err: error.message }, 'idp login failed');
        return errorPage(reply, 400, 'Sign-in failed. Try again or contact your administrator.', {
          back: BACK_TO_SIGN_IN,
        });
      }
      throw error;
    }
  };

  // An IdP that registers only the site origin (Synology SSO Server) returns to `/?code=...&state=...`. The login state
  // cookie of such a connection is sent to every path and names its connection; nothing else is taken for a callback.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET') return;
    const url = req.raw.url ?? '';
    const q = url.indexOf('?');
    if (q < 0 || url.slice(0, q) !== '/') return;
    const params = new URLSearchParams(url.slice(q + 1));
    if (!params.has('state') || !(params.has('code') || params.has('error'))) return;
    const raw = cookieValue(req, STATE_COOKIE);
    const sep = raw?.indexOf(STATE_ID_SEPARATOR) ?? -1;
    if (!raw || sep < 0) {
      return errorPage(reply, 400, 'The sign-in session expired. Try again.', {
        back: BACK_TO_SIGN_IN,
      });
    }
    return finishLogin(req, reply, raw.slice(0, sep), raw.slice(sep + 1), '/');
  });

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    // --- /auth/login ---------------------------------------------------------------------------------------
    scope.get<{ Querystring: Query }>('/auth/login', async (req, reply) => {
      const q = req.query;
      const returnTo = safeReturnTo(q.return_to ?? q.returnTo);
      const { connections, localEnabled } = await loadSignInOptions(infra);
      let connectionId = q.connection;
      let unrouted = false;
      if (!connectionId && q.email) {
        connectionId = routeByEmail(connections, q.email)?.id;
        unrouted = connectionId === undefined;
      }
      if (!connectionId && connections.length === 1 && !localEnabled) {
        connectionId = connections[0]?.id;
      }
      if (!connectionId) {
        return sendLoginPage(
          deps,
          req,
          reply,
          unrouted
            ? {
                returnTo,
                message: {
                  kind: 'info',
                  title: 'No single sign-on found for that email',
                  body: 'Choose a provider below, or check the address and try again.',
                },
              }
            : { returnTo },
        );
      }
      try {
        const started = await auth.idpLogin.startLogin(connectionId, {
          returnTo,
          ...(q.email ? { loginHint: q.email } : {}),
        });
        addCookie(
          reply,
          started.redirectToRoot
            ? stateCookie(
                `${started.connectionId}${STATE_ID_SEPARATOR}${started.stateToken}`,
                STATE_COOKIE_MAX_AGE,
                secure,
                '/',
              )
            : stateCookie(started.stateToken, STATE_COOKIE_MAX_AGE, secure),
        );
        return reply.header('cache-control', 'no-store').redirect(started.authorizationUrl, 302);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'idp login start failed',
        );
        return errorPage(reply, 400, 'This identity provider is not available.', {
          back: BACK_TO_SIGN_IN,
        });
      }
    });

    // --- /auth/forgot (9.1: there is no e-mail delivery in v1) -----------------------------------------------
    scope.get('/auth/forgot', async (_req, reply) => {
      const { connections, localEnabled } = await loadSignInOptions(infra);
      return sendHtml(
        reply,
        200,
        forgotPasswordPage({
          idpNames: connections.map((c) => c.name),
          localEnabled,
          host: new URL(infra.config.publicUrl).host,
        }),
      );
    });

    // --- /auth/callback/:idpConnectionId ----------------------------------------------------------------
    scope.get<{ Params: { idpConnectionId: string } }>(
      '/auth/callback/:idpConnectionId',
      (req, reply) =>
        finishLogin(
          req,
          reply,
          req.params.idpConnectionId,
          cookieValue(req, STATE_COOKIE),
          STATE_PATH,
        ),
    );

    // --- /auth/local (break-glass, 9.1) -----------------------------------------------------------------
    scope.post<{ Body: FormBody }>('/auth/local', async (req, reply) => {
      const body = (req.body ?? {}) as FormBody;
      const returnTo = safeReturnTo(body.return_to);
      const json = req.headers['content-type']?.includes('application/json') === true;
      if (!json && !formCsrfOk(req, body._csrf)) {
        return errorPage(reply, 403, 'The form expired. Reload the page and try again.', {
          back: BACK_TO_SIGN_IN,
        });
      }
      const email = (typeof body.email === 'string' ? body.email : '')
        .trim()
        .toLowerCase()
        .slice(0, MAX_EMAIL_LENGTH);
      const password = typeof body.password === 'string' ? body.password : '';
      // Throttle first. The answer is the same for existing and unknown accounts (22.3: no user enumeration).
      const wait = await loginBlockedFor(infra, req.ip, email);
      if (wait > 0) {
        reply.header('retry-after', String(wait));
        if (json) return reply.code(429).send({ error: 'too_many_attempts' });
        const minutes = Math.max(1, Math.ceil(wait / 60));
        return sendLoginPage(deps, req, reply, {
          returnTo,
          status: 429,
          email,
          message: {
            kind: 'error',
            title: 'Too many sign-in attempts',
            body: `Wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`,
          },
        });
      }
      const { localEnabled, idpCount } = await loadSignInOptions(infra);
      if (!localEnabled) {
        if (json) return reply.code(403).send({ error: 'local_login_disabled' });
        return sendLoginPage(deps, req, reply, {
          returnTo,
          status: 403,
          message: {
            kind: 'error',
            title: 'Password sign-in is turned off',
            body: 'Use single sign-on instead.',
          },
        });
      }
      const user = await verifyLocalLogin(
        { users: repos.localAdmins },
        { idpConnectionCount: idpCount, localLoginFlag: infra.config.localLogin },
        email,
        password,
      );
      if (!user) {
        await recordLoginFailure(infra, req.ip, email);
        if (json) return reply.code(401).send({ error: 'invalid_credentials' });
        return sendLoginPage(deps, req, reply, {
          returnTo,
          status: 401,
          email,
          message: {
            kind: 'error',
            title: 'Sign-in failed',
            body: 'The email or password is not correct. Check them and try again.',
          },
        });
      }
      await clearFailures(infra, ACCOUNT_RULE, email);
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
