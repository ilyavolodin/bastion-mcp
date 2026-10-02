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

const addConnection = async (
  h: UiHarness,
  input: { name: string; domains: string[]; enabled?: boolean },
) => {
  const secret = await h.infra.secretStore.put(
    { scope: 'org', ownerId: null, name: `idp:${input.name}` },
    h.idp.clientSecret,
  );
  return h.infra.repos.idpConnections.create({
    name: input.name,
    issuer: h.idp.issuer,
    discoveryUrl: h.idp.discoveryUrl,
    clientId: h.idp.clientId,
    clientSecretId: secret.id,
    scopes: ['openid', 'email', 'profile'],
    emailDomains: input.domains,
    storeRefreshToken: false,
    apiScope: null,
    enterpriseManagedAuth: false,
    enabled: input.enabled ?? true,
  });
};

describe.skipIf(!haveDocker())('9.1 sign-in page: break-glass rules and IdP routing', () => {
  describe('an IdP exists and BASTION_LOCAL_LOGIN is false', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness({ idpConnection: true });
      await h.infra.db.prisma.idpConnection.updateMany({
        data: { emailDomains: ['acme.example'] },
      });
      await addConnection(h, { name: 'Partner IdP', domains: ['partner.example'] });
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 the page says password sign-in is off instead of showing a dead form', async () => {
      const res = await h.browser().request(`${PUBLIC_ORIGIN}/auth/login`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Password sign-in is turned off');
      expect(text).not.toContain('type="password"');
      expect(text).toContain('Sign in with Acme SSO');
      expect(text).toContain('Sign in with Partner IdP');
      expect(text).toContain('name="email"');
    });

    it('9.1 a posted password form gets the same explanation, not a login', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login`);
      const res = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: csrfOf(await page.text()) || (b.cookie('bastion_csrf') ?? ''),
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Password sign-in is turned off');
      expect(b.cookie('bastion_sid')).toBeUndefined();
    });

    it('9.1 the email form routes by domain and says so when no domain matches', async () => {
      const routed = await h
        .browser()
        .request(`${PUBLIC_ORIGIN}/auth/login?email=pat%40partner.example`);
      expect(routed.status).toBe(302);
      expect(routed.headers.get('location')).toContain(new URL(h.idp.issuer).origin);
      const unknown = await h
        .browser()
        .request(`${PUBLIC_ORIGIN}/auth/login?email=x%40nowhere.test`);
      expect(unknown.status).toBe(200);
      expect(await unknown.text()).toContain('No single sign-on found for that email');
    });

    it('9.1 the forgot-password page points at the IdP reset and says local sign-in is off', async () => {
      const text = await (await h.browser().request(`${PUBLIC_ORIGIN}/auth/forgot`)).text();
      expect(text).toContain('Acme SSO');
      expect(text).toContain('reset your password with that identity provider');
      expect(text).toContain('Password sign-in is currently off');
    });
  });

  describe('an IdP exists and BASTION_LOCAL_LOGIN is true', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness({ idpConnection: true, env: { BASTION_LOCAL_LOGIN: 'true' } });
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 shows the IdP button and the local form, and the local login works', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login?return_to=/servers`);
      expect(page.status).toBe(200);
      const text = await page.text();
      expect(text).toContain('Sign in with Acme SSO');
      expect(text).toContain('type="password"');
      const res = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: csrfOf(text),
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          return_to: '/servers',
        }),
      });
      expect(res.status).toBe(303);
      expect(b.cookie('bastion_sid')).toBeDefined();
    });
  });

  describe('every IdP connection is disabled', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness({ idpConnection: false });
      await addConnection(h, { name: 'Off IdP', domains: [], enabled: false });
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 a connection that exists keeps local login off (the spec says "no IdP connection exists")', async () => {
      const b = h.browser();
      const page = await b.request(`${PUBLIC_ORIGIN}/auth/login`);
      const text = await page.text();
      expect(text).toContain('No sign-in method is available');
      expect(text).toContain('BASTION_LOCAL_LOGIN=true');
      expect(text).not.toContain('type="password"');
      const post = await b.request(`${PUBLIC_ORIGIN}/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      expect(post.status).toBe(403);
    });
  });

  describe('no IdP at all', () => {
    let h: UiHarness;
    beforeAll(async () => {
      h = await startUiHarness();
    });
    afterAll(async () => {
      await h.close();
    });

    it('9.1 shows only the local form, with the forgot link', async () => {
      const text = await (await h.browser().request(`${PUBLIC_ORIGIN}/auth/login`)).text();
      expect(text).toContain('type="password"');
      expect(text).not.toContain('Sign in with');
      expect(text).toContain('href="/auth/forgot"');
    });

    it('9.3 the OAuth login interaction page reuses the same sign-in template', async () => {
      // an unknown interaction is answered with the Bastion error page, not a bare message
      const res = await h.browser().request(`${PUBLIC_ORIGIN}/oauth/interaction/nope`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('Request expired');
      expect(text).toContain('/assets/pages.css?v=');
    });
  });
});
