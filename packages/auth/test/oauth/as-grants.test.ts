import { buildJwks } from '@bastion-mcp/secrets';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JWT_BEARER_GRANT } from '../../src/oauth/constants';
import { type Harness, HOST, ISSUER, startHarness, tokenRequest } from './as-harness';

let h: Harness;
beforeEach(async () => {
  h = await startHarness({ idJag: true });
});
afterEach(async () => {
  await h.close();
});

const jwksOf = () => createLocalJWKSet(buildJwks(h.keys.metas, new Date()) as never);

describe('9.3 client_credentials for service accounts', () => {
  it('9.3 client_secret_basic issues a service token with sub = service account and bastion:pt', async () => {
    const { clientId, clientSecret } = await h.as.preRegisterClient({
      kind: 'service',
      name: 'CI bot',
      authMethod: 'client_secret_basic',
    });
    h.serviceAccounts.set(clientId, 'sa-1');
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const result = await tokenRequest(
      h,
      { grant_type: 'client_credentials', scope: 'mcp' },
      { authorization: `Basic ${basic}` },
    );
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    const { payload } = await jwtVerify(String(result.json.access_token), jwksOf(), {
      issuer: ISSUER,
      audience: `https://${HOST}/mcp`,
    });
    expect(payload).toMatchObject({ sub: 'sa-1', client_id: clientId, 'bastion:pt': 'service' });
    expect(result.json.refresh_token).toBeUndefined();
  });

  it('9.3 a wrong secret is rejected', async () => {
    const { clientId } = await h.as.preRegisterClient({
      kind: 'service',
      name: 'CI bot',
      authMethod: 'client_secret_basic',
    });
    h.serviceAccounts.set(clientId, 'sa-1');
    const basic = Buffer.from(`${clientId}:nope`).toString('base64');
    const result = await tokenRequest(
      h,
      { grant_type: 'client_credentials' },
      { authorization: `Basic ${basic}` },
    );
    expect(result.status).toBe(401);
    expect(result.json.error).toBe('invalid_client');
  });

  it('9.3 the client secret is not stored in plaintext in oidc_models when a keyring is configured', async () => {
    const { startHarnessWithKeyring } = await import('./as-harness-keyring');
    const kh = await startHarnessWithKeyring();
    try {
      const { clientId, clientSecret } = await kh.as.preRegisterClient({
        kind: 'service',
        name: 'sealed',
        authMethod: 'client_secret_basic',
      });
      kh.serviceAccounts.set(clientId, 'sa-2');
      const row = await kh.models.find('Client', clientId);
      expect(JSON.stringify(row?.payload)).not.toContain(String(clientSecret));
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const result = await tokenRequest(
        kh,
        { grant_type: 'client_credentials' },
        { authorization: `Basic ${basic}` },
      );
      expect(result.status, JSON.stringify(result.json)).toBe(200);
    } finally {
      await kh.close();
    }
  });

  it('9.3 private_key_jwt authenticates a service account', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'ES256', use: 'sig', kid: 'sa' };
    const { clientId } = await h.as.preRegisterClient({
      kind: 'service',
      name: 'pkjwt bot',
      authMethod: 'private_key_jwt',
      jwks: { keys: [publicJwk] },
    });
    h.serviceAccounts.set(clientId, 'sa-3');
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'sa' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(ISSUER)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(pair.privateKey);
    const result = await tokenRequest(h, {
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
  });

  it('9.3 a client that is not a service account gets no client_credentials token', async () => {
    const { clientId, clientSecret } = await h.as.preRegisterClient({
      kind: 'service',
      name: 'orphan',
      authMethod: 'client_secret_basic',
    });
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const result = await tokenRequest(
      h,
      { grant_type: 'client_credentials' },
      { authorization: `Basic ${basic}` },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.json.error).toBe('unauthorized_client');
  });
});

describe('9.3 device authorization grant (RFC 8628) for bastion-credential', () => {
  const deviceAuth = async (scope: string) => {
    const response = await h.browser().request(`${ISSUER}/device/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'bastion-credential', scope }).toString(),
    });
    return { status: response.status, json: (await response.json()) as Record<string, string> };
  };

  it('9.3 starts a device flow with the plugins:read offline_access scopes', async () => {
    const result = await deviceAuth('plugins:read offline_access');
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json).toMatchObject({
      verification_uri: `${ISSUER}/device`,
    });
    expect(result.json.device_code).toBeTruthy();
    expect(result.json.user_code).toBeTruthy();
  });

  it('9.3 completes the device flow: pending, then a token after the user approves', async () => {
    const started = await deviceAuth('plugins:read offline_access');
    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: String(started.json.device_code),
      client_id: 'bastion-credential',
    };
    expect((await tokenRequest(h, body)).json.error).toBe('authorization_pending');

    const browser = h.browser();
    const page = await browser.request(`${ISSUER}/device`);
    const html = await page.text();
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
    expect(xsrf).toBeTruthy();
    const confirm = await browser.request(`${ISSUER}/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        xsrf: String(xsrf),
        user_code: String(started.json.user_code),
      }).toString(),
    });
    // Confirmation page (200) or a redirect into the interaction.
    let next = confirm;
    if (next.status === 200) {
      const confirmHtml = await next.text();
      const confirmXsrf = /name="xsrf" value="([^"]+)"/.exec(confirmHtml)?.[1];
      next = await browser.request(`${ISSUER}/device`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          xsrf: String(confirmXsrf),
          user_code: String(started.json.user_code),
          confirm: 'yes',
          abort: '',
        }).toString(),
      });
    }
    for (let i = 0; i < 8 && next.status >= 300 && next.status < 400; i += 1) {
      const location = next.headers.get('location') ?? '';
      next = await browser.request(new URL(location, `https://${HOST}`).href);
    }
    const granted = await tokenRequest(h, body);
    expect(granted.status, JSON.stringify(granted.json)).toBe(200);
    const { payload } = await jwtVerify(String(granted.json.access_token), jwksOf(), {
      issuer: ISSUER,
    });
    expect(payload).toMatchObject({ sub: 'user-1', client_id: 'bastion-credential' });
    expect(String(payload.scope)).toContain('plugins:read');
    expect(granted.json.refresh_token).toBeTruthy();
    expect(h.ui.consentViews).toHaveLength(0);
  });

  it('9.3 the credential client cannot request scopes beyond plugins:read offline_access', async () => {
    const result = await deviceAuth('mcp');
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('invalid_scope');
  });
});

describe('9.4 ID-JAG through the JWT bearer grant', () => {
  const publicClient = async () =>
    (
      await h.as.preRegisterClient({
        kind: 'public',
        name: 'agent',
        redirectUris: ['http://127.0.0.1:9/cb'],
        extraGrantTypes: [JWT_BEARER_GRANT],
      })
    ).clientId;

  it('9.4 issues a normal access token for the verified user and passes the expectations to the verifier', async () => {
    const clientId = await publicClient();
    const seen: unknown[] = [];
    h.idJag.verifier = {
      verify: async (assertion, expect_) => {
        seen.push({ assertion, ...expect_ });
        return { userId: 'user-9' };
      },
    };
    const result = await tokenRequest(h, {
      grant_type: JWT_BEARER_GRANT,
      assertion: 'the-id-jag',
      client_id: clientId,
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(seen).toEqual([
      { assertion: 'the-id-jag', audience: ISSUER, resource: `https://${HOST}/mcp`, clientId },
    ]);
    const { payload } = await jwtVerify(String(result.json.access_token), jwksOf(), {
      issuer: ISSUER,
      audience: `https://${HOST}/mcp`,
    });
    expect(payload).toMatchObject({ sub: 'user-9', client_id: clientId, 'bastion:pt': 'user' });
    expect(result.json.refresh_token).toBeUndefined();
  });

  it('9.4 honours a resource under /mcp and rejects foreign resources', async () => {
    const clientId = await publicClient();
    h.idJag.verifier = { verify: async () => ({ userId: 'user-9' }) };
    const ok = await tokenRequest(h, {
      grant_type: JWT_BEARER_GRANT,
      assertion: 'x',
      client_id: clientId,
      resource: `https://${HOST}/mcp/e/one`,
    });
    expect(ok.status).toBe(200);
    const bad = await tokenRequest(h, {
      grant_type: JWT_BEARER_GRANT,
      assertion: 'x',
      client_id: clientId,
      resource: 'https://evil.example/mcp',
    });
    expect(bad.json.error).toBe('invalid_target');
  });

  it('9.4 an assertion the verifier rejects is invalid_grant', async () => {
    const clientId = await publicClient();
    h.idJag.verifier = {
      verify: async () => {
        throw new Error('bad aud');
      },
    };
    const result = await tokenRequest(h, {
      grant_type: JWT_BEARER_GRANT,
      assertion: 'x',
      client_id: clientId,
    });
    expect(result.json.error).toBe('invalid_grant');
  });

  it('9.4 a missing assertion is invalid_request and a deactivated user invalid_grant', async () => {
    const clientId = await publicClient();
    h.idJag.verifier = { verify: async () => ({ userId: 'gone' }) };
    h.inactiveUsers.add('gone');
    expect(
      (await tokenRequest(h, { grant_type: JWT_BEARER_GRANT, client_id: clientId })).json.error,
    ).toBe('invalid_request');
    expect(
      (await tokenRequest(h, { grant_type: JWT_BEARER_GRANT, assertion: 'x', client_id: clientId }))
        .json.error,
    ).toBe('invalid_grant');
  });
});
