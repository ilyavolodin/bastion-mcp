import { CSRF_HEADER, SESSION_COOKIE } from '@bastion-mcp/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haveDocker } from './helpers/env';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  PUBLIC_ORIGIN,
  startUiHarness,
  type UiHarness,
} from './helpers/ui-harness';

const csrfOf = (html: string): string => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

describe.skipIf(!haveDocker())('9.1 / 9.2 browser login', () => {
  describe('local break-glass login', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness();
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 local login works while no IdP exists and creates a 9.2 session with CSRF cookie', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login?return_to=/servers`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
      const csrf = csrfOf(await page.text());
      expect(csrf).not.toBe('');
      const res = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: csrf,
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          return_to: '/servers',
        }),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/servers');
      const cookies = res.headers.getSetCookie().join('\n');
      expect(cookies).toMatch(
        /bastion_sid=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/,
      );
      expect(cookies).toMatch(/bastion_csrf=/);
      const principal = await h.auth.sessions.authenticate(b.cookie(SESSION_COOKIE) ?? '');
      expect(principal?.orgRole).toBe('admin');
    });

    it('9.1 a wrong password is refused and the form needs the CSRF token', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login`);
      const csrf = csrfOf(await page.text());
      const bad = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, email: ADMIN_EMAIL, password: 'nope-nope-nope' }),
      });
      expect(bad.status).toBe(401);
      const noCsrf = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      expect(noCsrf.status).toBe(403);
      expect(b.cookie(SESSION_COOKIE)).toBeUndefined();
    });

    it('9.2 logout needs the double-submit header and destroys the session', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login`);
      await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: csrfOf(await page.text()),
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        }),
      });
      const sid = b.cookie(SESSION_COOKIE) ?? '';
      expect(await h.auth.sessions.authenticate(sid)).not.toBeNull();
      const denied = await b.request(`${PUBLIC_ORIGIN}/auth/logout`, { method: 'POST' });
      expect(denied.status).toBe(403);
      const ok = await b.request(`${PUBLIC_ORIGIN}/auth/logout`, {
        method: 'POST',
        headers: { [CSRF_HEADER]: b.cookie('bastion_csrf') ?? '' },
      });
      expect(ok.status).toBe(204);
      expect(await h.auth.sessions.authenticate(sid)).toBeNull();
    });

    it('9.1 local login attempts are rate limited per client address', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login`);
      const csrf = csrfOf(await page.text());
      let last = 0;
      for (let i = 0; i < 12; i++) {
        const r = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            _csrf: csrf,
            email: `x${i}@acme.example`,
            password: 'wrong-password-1',
          }),
        });
        last = r.status;
      }
      expect(last).toBe(429);
    });
  });

  describe('OIDC login with an IdP connection', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness({ idpConnection: true });
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 first login provisions the user, maps groups to a role, sets a session and returns to the SPA', async () => {
      const b = h.browser();
      const { response, url } = await b.follow(
        `${PUBLIC_ORIGIN}/auth/login?return_to=/servers`,
        undefined,
        (u) => new URL(u).pathname === '/servers',
      );
      expect(url).toBe(`${PUBLIC_ORIGIN}/servers`);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/servers');
      const sid = b.cookie(SESSION_COOKIE) ?? '';
      const principal = await h.auth.sessions.authenticate(sid);
      expect(principal?.orgRole).toBe('admin');
      const user = await h.infra.repos.users.findByEmail('ada@acme.example');
      expect(user?.displayName).toBe('Ada Lovelace');
      expect(user?.status).toBe('active');
    });

    it('9.1 a second login reuses the user and ignores an open-redirect return_to', async () => {
      const b = h.browser();
      const { response } = await b.follow(
        `${PUBLIC_ORIGIN}/auth/login?return_to=//evil.example/x`,
        undefined,
        (u) => new URL(u).pathname === '/',
      );
      expect(response.headers.get('location')).toBe('/');
      const again = await h.infra.repos.users.list({ q: 'ada' });
      expect(again.items).toHaveLength(1);
    });

    it('9.1 local login is disabled once an IdP connection exists', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login`);
      // a single IdP connection: straight to the IdP
      expect(page.status).toBe(302);
      const res = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'local_login_disabled' });
    });

    it('9.1 a callback without the state cookie is refused', async () => {
      const connection = (await h.infra.repos.idpConnections.list())[0];
      const res = await h
        .browser()
        .request(`${PUBLIC_ORIGIN}/auth/callback/${connection?.id}?code=x&state=y`);
      expect(res.status).toBe(400);
    });
  });

  describe('OIDC login with an IdP that accepts only the site origin (Synology SSO Server)', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness({ idpConnection: true, idpRedirectToRoot: true });
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 the IdP is sent the bare site origin and the sign-in completes at /', async () => {
      const b = h.browser();
      const start = await b.request(`${PUBLIC_ORIGIN}/auth/login?return_to=/servers`);
      expect(start.status).toBe(302);
      const authorize = new URL(start.headers.get('location') ?? '');
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/`);
      // The state cookie of this connection is sent to `/`, where the IdP returns.
      expect(start.headers.getSetCookie().join('\n')).toMatch(
        /bastion_login=[^;]+~[^;]+; Path=\/;/,
      );

      const { response, url } = await b.follow(
        `${PUBLIC_ORIGIN}/auth/login?return_to=/servers`,
        undefined,
        (u) => new URL(u).pathname === '/servers',
      );
      expect(url).toBe(`${PUBLIC_ORIGIN}/servers`);
      expect(response.status).toBe(302);
      const principal = await h.auth.sessions.authenticate(b.cookie(SESSION_COOKIE) ?? '');
      expect(principal?.orgRole).toBe('admin');
      expect((await h.infra.repos.users.findByEmail('ada@acme.example'))?.status).toBe('active');
    });

    it('9.1 a return to / with a code but no login state is refused, and the state cookie is single use', async () => {
      const b = h.browser();
      const res = await b.request(`${PUBLIC_ORIGIN}/?code=x&state=y`);
      expect(res.status).toBe(400);
      // Without the pair of parameters the root is not a callback at all (the SPA gets it).
      expect((await b.request(`${PUBLIC_ORIGIN}/?utm=1`)).status).toBe(404);

      const first = h.browser();
      const start = await first.request(`${PUBLIC_ORIGIN}/auth/login`);
      const query = await h.idp.authorize(start.headers.get('location') ?? '');
      const done = await first.request(`${PUBLIC_ORIGIN}/?${query}`);
      expect(done.status).toBe(302);
      const replay = await first.request(`${PUBLIC_ORIGIN}/?${query}`);
      expect(replay.status).toBe(400);
    });
  });
});
