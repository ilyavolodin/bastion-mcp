import { verifyPassword } from '@bastion-mcp/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '../src/cli';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { Browser } from './helpers/proxy-fetch';
import { bootStack, type Stack } from './helpers/stack';

const EMAIL = 'root@acme.example';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const csrfOf = (html: string): string => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

const capture = (stdin = '') => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (l: string) => void out.push(l),
      err: (l: string) => void err.push(l),
      stdin: async () => stdin,
    },
  };
};

describe.skipIf(!haveDocker())(
  '9.1 / 20.1 local password change, reset and login throttling',
  () => {
    let env: TestEnv;
    let stack: Stack;
    let bootstrapPassword = '';
    const url = (path: string) => stack.url(path);
    const newBrowser = () => new Browser(stack.fetch);

    /** A fresh browser signed in through the form. */
    const signIn = async (password: string, headers: Record<string, string> = {}) => {
      const b = newBrowser();
      const page = await b.request(url('/auth/login'), { headers });
      const res = await b.post(
        url('/auth/local'),
        { _csrf: csrfOf(page.text), email: EMAIL, password, return_to: '/' },
        headers,
      );
      return { b, res };
    };

    const api = (b: Browser, method: string, path: string, body?: unknown) =>
      b.request(url(`/api/v1${path}`), {
        method,
        headers: {
          'content-type': 'application/json',
          'x-bastion-csrf': b.jar.get(url('/'), 'bastion_csrf') ?? '',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    beforeAll(async () => {
      env = await createTestEnv();
      stack = await bootStack({
        env,
        vars: { BASTION_BOOTSTRAP_ADMIN_EMAIL: EMAIL },
        options: {
          printBootstrapPassword: (_email, password) => {
            bootstrapPassword = password;
          },
        },
      });
    });
    afterAll(async () => {
      await stack?.stop();
      await env?.cleanup();
    });

    describe('POST /api/v1/me/password', () => {
      it('9.1 changes the password, keeps this session, revokes the others and audits it', async () => {
        const first = await signIn(bootstrapPassword);
        expect(first.res.status).toBe(303);
        const second = await signIn(bootstrapPassword);
        expect(second.res.status).toBe(303);
        expect((await api(first.b, 'GET', '/me')).status).toBe(200);
        expect((await api(second.b, 'GET', '/me')).status).toBe(200);

        const wrong = await api(first.b, 'POST', '/me/password', {
          currentPassword: 'not the password at all',
          newPassword: 'a brand new passphrase 77',
        });
        expect(wrong.status).toBe(400);
        expect(JSON.parse(wrong.text).errors).toEqual([
          { path: 'currentPassword', message: 'The current password is not correct.' },
        ]);

        const reuse = await api(first.b, 'POST', '/me/password', {
          currentPassword: bootstrapPassword,
          newPassword: bootstrapPassword,
        });
        expect(reuse.status).toBe(400);
        expect(JSON.parse(reuse.text).errors[0].path).toBe('newPassword');

        const short = await api(first.b, 'POST', '/me/password', {
          currentPassword: bootstrapPassword,
          newPassword: 'short',
        });
        expect(short.status).toBe(400);

        const ok = await api(first.b, 'POST', '/me/password', {
          currentPassword: bootstrapPassword,
          newPassword: 'a brand new passphrase 77',
        });
        expect(ok.status).toBe(200);
        expect(JSON.parse(ok.text)).toEqual({ changed: true });

        expect((await api(first.b, 'GET', '/me')).status).toBe(200);
        expect((await api(second.b, 'GET', '/me')).status).toBe(401);

        const old = await signIn(bootstrapPassword);
        expect(old.res.status).toBe(401);
        const fresh = await signIn('a brand new passphrase 77');
        expect(fresh.res.status).toBe(303);
        expect((await api(fresh.b, 'GET', '/me')).status).toBe(200);

        const user = await stack.server.infra.repos.localAdmins.findByEmail(EMAIL);
        expect(
          await verifyPassword(user?.localPasswordHash ?? '', 'a brand new passphrase 77'),
        ).toBe(true);
        const audits = await stack.server.infra.db.prisma.auditEvent.findMany({
          where: { action: 'user.password_change' },
        });
        expect(audits).toHaveLength(1);
        expect(audits[0]?.actorId).toBe(user?.id);
        expect(JSON.stringify(audits[0]?.diff)).not.toContain('passphrase');
        // the next tests need the known password
        bootstrapPassword = 'a brand new passphrase 77';
      });

      it('9.1 requires the CSRF header and a session or token', async () => {
        const { b } = await signIn(bootstrapPassword);
        const noCsrf = await b.request(url('/api/v1/me/password'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
        });
        expect(noCsrf.status).toBe(403);
        const anonymous = await newBrowser().request(url('/api/v1/me/password'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
        });
        expect(anonymous.status).toBe(401);
      });

      it('9.1 five wrong current passwords lock the endpoint for that account', async () => {
        const { b } = await signIn(bootstrapPassword);
        let last = 0;
        for (let i = 0; i < 5; i++) {
          last = (
            await api(b, 'POST', '/me/password', {
              currentPassword: `wrong password number ${i}`,
              newPassword: 'another fine passphrase 5',
            })
          ).status;
          expect(last).toBe(400);
        }
        const locked = await api(b, 'POST', '/me/password', {
          currentPassword: bootstrapPassword,
          newPassword: 'another fine passphrase 5',
        });
        expect(locked.status).toBe(429);
        await stack.server.infra.redis.flushall();
      });
    });

    describe('bastion reset-password', () => {
      it('20.1 prints a new random password once, signs everything out and audits it', async () => {
        const { b } = await signIn(bootstrapPassword);
        const pat = await api(b, 'POST', '/tokens', { name: 'ci', scopes: ['api:read'] });
        expect(pat.status).toBe(201);
        const token = JSON.parse(pat.text).token as string;
        const asToken = () =>
          stack.fetch(url('/api/v1/me'), { headers: { authorization: `Bearer ${token}` } });
        expect((await asToken()).status).toBe(200);

        const c = capture();
        expect(
          await execute(['reset-password', '--email', ` ${EMAIL.toUpperCase()} `], env.env(), c.io),
        ).toBe(0);
        const printed = /new password \(shown once\): (\S+)/.exec(c.out.join('\n'))?.[1] ?? '';
        expect(printed).toHaveLength(33);
        expect(c.out.join('\n')).toContain('all sessions and tokens of this user were revoked');

        expect((await api(b, 'GET', '/me')).status).toBe(401);
        expect((await asToken()).status).toBe(401);
        expect((await signIn(bootstrapPassword)).res.status).toBe(401);
        // a login in the same second as the revocation is valid
        const fresh = await signIn(printed);
        expect(fresh.res.status).toBe(303);
        expect((await api(fresh.b, 'GET', '/me')).status).toBe(200);
        bootstrapPassword = printed;

        const audit = await stack.server.infra.db.prisma.auditEvent.findMany({
          where: { action: 'user.password_reset' },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.actorType).toBe('system');
        expect(JSON.stringify(audit[0]?.diff)).not.toContain(printed);
      });

      it('20.1 --password-stdin sets the supplied password and never prints it', async () => {
        const c = capture('chosen by the operator 42\n');
        expect(
          await execute(['reset-password', '--email', EMAIL, '--password-stdin'], env.env(), c.io),
        ).toBe(0);
        expect(c.out.join('\n')).not.toContain('chosen by the operator 42');
        expect(c.out.join('\n')).toContain('reset');
        expect((await signIn('chosen by the operator 42')).res.status).toBe(303);
        bootstrapPassword = 'chosen by the operator 42';
      });

      it('20.1 refuses weak passwords, unknown accounts and IdP accounts; needs --email', async () => {
        const weak = capture('short\n');
        expect(
          await execute(
            ['reset-password', '--email', EMAIL, '--password-stdin'],
            env.env(),
            weak.io,
          ),
        ).toBe(1);
        expect(weak.err.join('\n')).toMatch(/at least 12/);
        const unknown = capture();
        expect(
          await execute(
            ['reset-password', '--email', 'nobody@acme.example'],
            env.env(),
            unknown.io,
          ),
        ).toBe(1);
        expect(unknown.err.join('\n')).toContain('no account');
        await stack.server.infra.repos.users.create(
          { email: 'sso@acme.example', displayName: 'SSO user', idpConnectionId: null },
          { audit: { actorType: 'system' } },
        );
        const sso = capture();
        expect(
          await execute(['reset-password', '--email', 'sso@acme.example'], env.env(), sso.io),
        ).toBe(1);
        expect(sso.err.join('\n')).toContain('identity provider');
        const missing = capture();
        expect(await execute(['reset-password'], env.env(), missing.io)).toBe(2);
      });

      it('20.1 appears in the help text', async () => {
        const c = capture();
        expect(await execute(['--help'], {}, c.io)).toBe(0);
        expect(c.out.join('\n')).toContain('reset-password --email');
      });
    });

    describe('local login throttling (9.1, 22.3)', () => {
      const attempt = async (email: string, password: string, ip: string) => {
        const b = newBrowser();
        const page = await b.request(url('/auth/login'), { headers: { 'x-forwarded-for': ip } });
        return b.post(
          url('/auth/local'),
          { _csrf: csrfOf(page.text), email, password },
          { 'x-forwarded-for': ip },
        );
      };

      it('9.1 an account is blocked after five failures from any addresses, with the same answer for unknown accounts', async () => {
        await stack.server.infra.redis.flushall();
        const blocked: Record<string, { status: number; retry: boolean; title: boolean }> = {};
        for (const email of [EMAIL, 'ghost@acme.example']) {
          for (let i = 0; i < 5; i++) {
            const r = await attempt(email, `wrong password ${i}`, `10.0.${email.length}.${i + 1}`);
            expect(r.status).toBe(401);
            expect(r.text).toContain('Sign-in failed');
          }
          const sixth = await attempt(email, bootstrapPassword, '10.9.9.9');
          blocked[email] = {
            status: sixth.status,
            retry: sixth.headers.has('retry-after'),
            title: sixth.text.includes('Too many sign-in attempts'),
          };
        }
        expect(blocked[EMAIL]).toEqual({ status: 429, retry: true, title: true });
        expect(blocked['ghost@acme.example']).toEqual(blocked[EMAIL]);
      });

      it('9.1 one address is blocked after ten failures whatever accounts it tries', async () => {
        await stack.server.infra.redis.flushall();
        for (let i = 0; i < 10; i++) {
          expect((await attempt(`u${i}@acme.example`, 'wrong password x', '10.7.7.7')).status).toBe(
            401,
          );
        }
        expect((await attempt(EMAIL, bootstrapPassword, '10.7.7.7')).status).toBe(429);
        // another address is not affected
        expect((await attempt(EMAIL, bootstrapPassword, '10.7.7.8')).status).toBe(303);
      });

      it('9.1 a success clears the account counter; JSON clients get 429 and Retry-After', async () => {
        await stack.server.infra.redis.flushall();
        for (let i = 0; i < 4; i++) await attempt(EMAIL, `wrong password ${i}`, `10.1.1.${i + 1}`);
        expect((await attempt(EMAIL, bootstrapPassword, '10.1.1.9')).status).toBe(303);
        for (let i = 0; i < 4; i++) {
          expect((await attempt(EMAIL, `wrong again ${i}`, `10.2.2.${i + 1}`)).status).toBe(401);
        }
        for (let i = 0; i < 2; i++) await attempt(EMAIL, 'wrong again x', `10.3.3.${i + 1}`);
        const json = await stack.fetch(url('/auth/local'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.4.4.4' },
          body: JSON.stringify({ email: EMAIL, password: bootstrapPassword }),
        });
        expect(json.status).toBe(429);
        expect(Number(json.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(await json.json()).toEqual({ error: 'too_many_attempts' });
        await stack.server.infra.redis.flushall();
      });

      it('22.3 a wrong password and an unknown account take comparable time (dummy hash)', async () => {
        await stack.server.infra.redis.flushall();
        const time = async (email: string) => {
          const t0 = performance.now();
          await attempt(
            email,
            'wrong password zz',
            `10.5.5.${Math.floor(Math.random() * 200) + 1}`,
          );
          return performance.now() - t0;
        };
        await time(EMAIL);
        const known = await time(EMAIL);
        const unknown = await time('ghost2@acme.example');
        // both verify an argon2id hash; neither answer is an order of magnitude faster
        expect(unknown).toBeGreaterThan(known / 4);
        expect(known).toBeGreaterThan(unknown / 4);
        await sleep(10);
      });
    });

    describe('server-rendered pages', () => {
      it('9.2 the sign-in page is a Zest page under a strict CSP with a forgot-password link', async () => {
        const res = await newBrowser().request(url('/auth/login'));
        expect(res.status).toBe(200);
        const csp = res.headers.get('content-security-policy') ?? '';
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toContain('unsafe-inline');
        expect(res.text).toContain('/assets/pages.css?v=');
        expect(res.text).toContain('href="/auth/forgot"');
        expect(res.text).not.toContain('fonts.googleapis.com');
        expect(res.text).toContain('autocomplete="current-password"');
      });

      it('9.2 serves the stylesheet, the theme script and the self-hosted fonts', async () => {
        const css = await stack.fetch(url('/assets/pages.css'));
        expect(css.status).toBe(200);
        expect(css.headers.get('content-type')).toContain('text/css');
        const text = await css.text();
        expect(text).toContain('--tangerine:#ff8a1f');
        expect(text).toContain('font-family:"Poppins"');
        const js = await stack.fetch(url('/assets/pages-theme.js'));
        expect(js.headers.get('content-type')).toContain('javascript');
        for (const w of [400, 500, 600, 700]) {
          const font = await stack.fetch(url(`/assets/fonts/poppins-latin-${w}.woff2`));
          expect(font.status).toBe(200);
          expect(font.headers.get('content-type')).toBe('font/woff2');
          expect(
            Buffer.from(await font.arrayBuffer())
              .subarray(0, 4)
              .toString('latin1'),
          ).toBe('wOF2');
        }
        expect((await stack.fetch(url('/assets/fonts/evil.woff2'))).status).toBe(404);
      });

      it('9.1 the forgot-password page explains the CLI and Docker commands', async () => {
        const res = await newBrowser().request(url('/auth/forgot'));
        expect(res.status).toBe(200);
        expect(res.text).toContain('bastion reset-password --email you@example.com');
        expect(res.text).toContain('docker compose exec bastion bastion reset-password');
        expect(res.text).toContain('Change password');
      });

      it('9.3 device flow pages use Bastion templates and the strict CSP (no Google Fonts)', async () => {
        const auth = await stack.fetch(url('/oauth/device/auth'), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'bastion-credential', scope: 'plugins:read' }),
        });
        expect(auth.status).toBe(200);
        const device = (await auth.json()) as { user_code: string; verification_uri: string };
        const b = newBrowser();
        const input = await b.request(url('/oauth/device'));
        expect(input.status).toBe(200);
        expect(input.text).toContain('/assets/pages.css?v=');
        expect(input.text).toContain('Device code');
        expect(input.text).not.toContain('fonts.googleapis.com');
        expect(input.text).not.toContain('onfocus');
        expect(input.headers.get('content-security-policy')).not.toContain('unsafe-inline');
        const xsrf = /name="xsrf" value="([^"]+)"/.exec(input.text)?.[1] ?? '';

        const wrong = await b.post(url('/oauth/device'), { xsrf, user_code: 'ZZZZ-ZZZZ' });
        expect(wrong.text).toContain('That code is not right');

        const xsrf2 = /name="xsrf" value="([^"]+)"/.exec(wrong.text)?.[1] ?? '';
        const confirm = await b.post(url('/oauth/device'), {
          xsrf: xsrf2,
          user_code: device.user_code,
        });
        expect(confirm.status).toBe(200);
        expect(confirm.text).toContain('Confirm device');
        expect(confirm.text).toContain('Bastion credential helper');
        expect(confirm.text).toContain(device.user_code.slice(0, 4));
      });

      it('9.3 provider errors are rendered with the Bastion error page', async () => {
        const res = await newBrowser().request(
          url('/oauth/auth?client_id=nope&response_type=code'),
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.text).toContain('/assets/pages.css?v=');
        expect(res.text).toContain('invalid_client');
        expect(res.text).not.toContain('fonts.googleapis.com');
      });
    });
  },
);
