import { sha256Hex } from '@bastion-mcp/core';
import { type FakeUpstream, startFakeUpstream } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haveDocker } from './helpers/env';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  type Browser,
  makeBrowser,
  PUBLIC_ORIGIN,
  startUiHarness,
  type UiHarness,
} from './helpers/ui-harness';

const csrfOf = (html: string): string => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

describe.skipIf(!haveDocker())('9.1 SCIM and 9.6 upstream OAuth pages', () => {
  let h: UiHarness;
  let upstream: FakeUpstream;
  let adminId: string;
  beforeAll(async () => {
    h = await startUiHarness();
    upstream = await startFakeUpstream();
    adminId = (await h.infra.repos.users.findByEmail(ADMIN_EMAIL))?.id ?? '';
  });
  afterAll(async () => {
    await upstream.close();
    await h.close();
  });

  const signIn = async (): Promise<Browser> => {
    const b = makeBrowser(h.base, [upstream.origin]);
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
    return b;
  };

  describe('SCIM at /scim/v2', () => {
    const token = 'scim-secret-token-for-tests';
    const scim = (path: string, init: RequestInit = {}) =>
      h.fetch(`${PUBLIC_ORIGIN}/scim/v2${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/scim+json',
          ...init.headers,
        },
      });

    beforeAll(async () => {
      await h.infra.repos.scimTokens.create({
        name: 'okta',
        tokenSha256: sha256Hex(token),
        createdBy: adminId,
      });
    });

    it('9.1 rejects requests without a valid bearer token', async () => {
      const res = await h.fetch(`${PUBLIC_ORIGIN}/scim/v2/Users`, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/scim+json');
    });

    it('9.1 SCIM create provisions a user, filter finds it, active=false deactivates it', async () => {
      const created = await scim('/Users', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'grace@acme.example',
          displayName: 'Grace Hopper',
          externalId: 'okta-123',
          active: true,
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { id: string; userName: string };
      expect(body.userName).toBe('grace@acme.example');
      const row = await h.infra.repos.users.findByEmail('grace@acme.example');
      expect(row?.status).toBe('active');
      expect(row?.id).toBe(body.id);

      const found = await scim(
        `/Users?filter=${encodeURIComponent('userName eq "grace@acme.example"')}`,
      );
      expect(found.status).toBe(200);
      expect(((await found.json()) as { totalResults: number }).totalResults).toBe(1);

      const patched = await scim(`/Users/${body.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        }),
      });
      expect(patched.status).toBe(200);
      expect((await h.infra.repos.users.findByEmail('grace@acme.example'))?.status).toBe(
        'deactivated',
      );
    });
  });

  describe('/connect and the upstream OAuth callback', () => {
    let installationId: string;
    beforeAll(async () => {
      const installation = await h.infra.repos.installations.create({
        ownerType: 'user',
        ownerId: adminId,
        slug: 'upstream',
        displayName: 'Upstream',
        personalSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: upstream.mcpUrl,
          auth: { mode: 'oauth', client: { registration: 'auto' }, scopes: ['read'] },
        },
        origin: 'manual',
      });
      installationId = installation.id;
    });

    it('9.6 serves the client metadata document and the JWKS of the upstream-client keyring', async () => {
      const meta = await h.fetch(`${PUBLIC_ORIGIN}/oauth/upstream/client-metadata.json`);
      const doc = (await meta.json()) as Record<string, unknown>;
      expect(doc.client_id).toBe(`${PUBLIC_ORIGIN}/oauth/upstream/client-metadata.json`);
      expect(doc.redirect_uris).toEqual([`${PUBLIC_ORIGIN}/oauth/upstream/callback`]);
      expect(doc.token_endpoint_auth_method).toBe('private_key_jwt');
      const jwks = (await (await h.fetch(`${PUBLIC_ORIGIN}/oauth/upstream/jwks`)).json()) as {
        keys: { kid: string; d?: string }[];
      };
      expect(jwks.keys.length).toBeGreaterThan(0);
      expect(jwks.keys.every((k) => k.d === undefined)).toBe(true);
    });

    it('9.6 /connect requires a session, then names the upstream AS and needs a click before redirecting', async () => {
      const anonymous = await h.browser().request(`${PUBLIC_ORIGIN}/connect/${installationId}`);
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get('location')).toContain('/auth/login?return_to=');

      const b = await signIn();
      const page = await b.request(`${PUBLIC_ORIGIN}/connect/${installationId}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(new URL(upstream.origin).host);
      // consent before redirect: no redirect happened, the page carries a POST form with CSRF
      expect(html).toContain(`action="/connect/${installationId}"`);
      expect(upstream.requests.some((r) => r.path === '/authorize')).toBe(false);

      const noCsrf = await b.request(`${PUBLIC_ORIGIN}/connect/${installationId}`, {
        method: 'POST',
      });
      expect(noCsrf.status).toBe(403);

      const { response, url } = await b.follow(
        `${PUBLIC_ORIGIN}/connect/${installationId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrfOf(html) }),
        },
        (next) => new URL(next).pathname.startsWith('/servers/'),
      );
      expect(response.status).toBe(302);
      expect(url).toBe(`${PUBLIC_ORIGIN}/servers/${installationId}?connected=1`);

      const status = await h.auth.broker.status(adminId, installationId);
      expect(status?.status).toBe('valid');
      expect(status?.scopes).toEqual(['read']);
      const token = await h.auth.broker.accessToken(
        { type: 'user', id: adminId },
        {
          id: installationId,
          name: 'upstream',
          kind: 'remote',
          upstreamUrl: upstream.mcpUrl,
          auth: { mode: 'oauth', client: { registration: 'auto' }, scopes: ['read'] },
        },
      );
      expect(token?.accessToken).toMatch(/^up-at-/);
      expect((await upstream.callMcp(token?.accessToken ?? null)).status).toBe(200);
    });

    it('9.6 connecting from the Test step of the catalog editor returns to that step and runs the test again', async () => {
      const spec = {
        type: 'remote' as const,
        transport: 'streamable-http' as const,
        url: upstream.mcpUrl,
        auth: { mode: 'oauth' as const, client: { registration: 'auto' as const } },
      };
      const entry = await h.infra.repos.catalogEntries.create({
        slug: 'oauth-under-test',
        displayName: 'OAuth under test',
        description: 'an OAuth server being tested',
        createdBy: adminId,
      });
      const version = await h.infra.repos.catalogVersions.create({
        entryId: entry.id,
        label: '0.1.0',
        serverSpec: spec,
        installForm: { variables: [], secrets: [] },
        createdBy: adminId,
      });
      const test = await h.infra.repos.installations.create({
        ownerType: 'user',
        ownerId: adminId,
        catalogEntryId: entry.id,
        catalogVersionId: version.id,
        pinnedVersion: true,
        slug: 'test-oauth-under',
        displayName: 'Test of OAuth under test',
        enabled: false,
        variables: {},
        origin: 'test',
        status: 'ready',
      });

      const b = await signIn();
      const html = await (await b.request(`${PUBLIC_ORIGIN}/connect/${test.id}`)).text();
      const { response, url } = await b.follow(
        `${PUBLIC_ORIGIN}/connect/${test.id}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrfOf(html) }),
        },
        (next) => new URL(next).pathname.startsWith('/catalog/'),
      );
      expect(response.status).toBe(302);
      expect(url).toBe(`${PUBLIC_ORIGIN}/catalog/${entry.id}?step=test&run=1`);
      expect((await h.auth.broker.status(adminId, test.id))?.status).toBe('valid');
    });

    it('9.6 another user cannot start the flow for an installation they do not own', async () => {
      const other = await h.infra.repos.users.create({
        email: 'mallory@acme.example',
        displayName: 'Mallory',
      });
      const session = await h.auth.sessions.create({ principalId: other.id });
      const b = makeBrowser(h.base, [upstream.origin]);
      b.jar.set('bastion_sid', session.id);
      const res = await b.request(`${PUBLIC_ORIGIN}/connect/${installationId}`);
      expect(res.status).toBe(404);
    });

    it('9.6 a callback with a forged state is refused', async () => {
      const b = await signIn();
      const res = await b.request(`${PUBLIC_ORIGIN}/oauth/upstream/callback?code=abc&state=bogus`);
      expect(res.status).toBe(400);
    });
  });
});
