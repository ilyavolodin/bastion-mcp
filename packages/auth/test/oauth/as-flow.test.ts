import { buildJwks } from '@bastion-mcp/secrets';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  codeFlow,
  type Harness,
  HOST,
  ISSUER,
  pkcePair,
  REDIRECT,
  registerClient,
  startHarness,
  tokenRequest,
} from './as-harness';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

const jwksOf = () => createLocalJWKSet(buildJwks(h.keys.metas, new Date()) as never);
const newClient = async (metadata: Record<string, unknown> = {}) =>
  String((await registerClient(h, metadata)).json.client_id);
const DAY = 86_400_000;

describe('9.3 metadata', () => {
  it('9.3 serves RFC 8414 path-form and OIDC discovery metadata with PKCE S256 only', async () => {
    const browser = h.browser();
    const a = (await (
      await browser.request(`https://${HOST}/.well-known/oauth-authorization-server/oauth`)
    ).json()) as Record<string, unknown>;
    const b = await (await browser.request(`${ISSUER}/.well-known/openid-configuration`)).json();
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/token`,
      authorization_endpoint: `${ISSUER}/auth`,
      jwks_uri: `${ISSUER}/jwks`,
      registration_endpoint: `${ISSUER}/reg`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      device_authorization_endpoint: `${ISSUER}/device/auth`,
    });
    expect(a.grant_types_supported).toEqual(
      expect.arrayContaining([
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
      ]),
    );
    expect(a.scopes_supported).toEqual(
      expect.arrayContaining(['mcp', 'api:read', 'api:write', 'plugins:read', 'offline_access']),
    );
  });

  it('9.3 publishes the JWKS with active and not-yet-retired keys', async () => {
    const jwks = (await (await h.browser().request(`${ISSUER}/jwks`)).json()) as {
      keys: { kid: string; d?: string }[];
    };
    expect(jwks.keys.map((k) => k.kid)).toEqual([h.keys.metas[0]?.kid]);
    expect(jwks.keys.every((k) => k.d === undefined)).toBe(true);
  });

  it('9.3 non-OAuth paths are not served by the AS listener', async () => {
    const response = await h.browser().request(`https://${HOST}/mcp`);
    expect(response.status).toBe(404);
  });
});

describe('9.3 authorization code + PKCE', () => {
  it('9.3 issues an RFC 9068 ES256 JWT access token with the specified claims', async () => {
    const clientId = await newClient();
    const flow = await codeFlow(h, clientId);
    expect(flow.status, flow.callback.href).toBe(200);
    const token = String(flow.json.access_token);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
    const { payload } = await jwtVerify(token, jwksOf(), {
      issuer: ISSUER,
      audience: `https://${HOST}/mcp`,
    });
    expect(payload).toMatchObject({
      sub: 'user-1',
      client_id: clientId,
      scope: expect.stringContaining('mcp'),
      'bastion:pt': 'user',
    });
    expect(payload.jti).toBeTruthy();
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(900);
    expect(flow.json.refresh_token).toBeTruthy();
    expect(flow.json.expires_in).toBe(900);
  });

  it('9.3 RFC 9207: the authorization response includes iss', async () => {
    const flow = await codeFlow(h, await newClient());
    expect(flow.callback.searchParams.get('iss')).toBe(ISSUER);
  });

  it('9.3 requires PKCE: a request without code_challenge is refused', async () => {
    const clientId = await newClient();
    const callback = await h.browser().authorize({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
    });
    expect(callback.searchParams.get('error')).toBe('invalid_request');
    expect(callback.searchParams.get('iss')).toBe(ISSUER);
  });

  it('9.3 rejects the plain challenge method', async () => {
    const clientId = await newClient();
    const callback = await h.browser().authorize({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'plain',
    });
    expect(callback.searchParams.get('error')).toBe('invalid_request');
  });

  it('9.3 a wrong code_verifier cannot redeem the code', async () => {
    const clientId = await newClient();
    const { challenge } = pkcePair();
    const callback = await h.browser().authorize({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const result = await tokenRequest(h, {
      grant_type: 'authorization_code',
      code: String(callback.searchParams.get('code')),
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: pkcePair().verifier,
    });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('invalid_grant');
  });

  it('9.3 an authorization code is single use', async () => {
    const clientId = await newClient();
    const { verifier, challenge } = pkcePair();
    const callback = await h.browser().authorize({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const body = {
      grant_type: 'authorization_code',
      code: String(callback.searchParams.get('code')),
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    expect((await tokenRequest(h, body)).status).toBe(200);
    expect((await tokenRequest(h, body)).json.error).toBe('invalid_grant');
  });

  it('9.3 loopback redirect URIs match on any port (RFC 8252)', async () => {
    const clientId = await newClient();
    const flow = await codeFlow(h, clientId, { redirectUri: 'http://127.0.0.1:54321/callback' });
    expect(flow.status, flow.callback.href).toBe(200);
  });

  it('9.3 a redirect URI that is not registered is rejected without redirecting', async () => {
    const clientId = await newClient();
    await expect(
      h.browser().authorize({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: 'https://evil.example/cb',
        scope: 'mcp',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
      }),
    ).rejects.toThrow(/400/);
  });
});

describe('9.3 resources (RFC 8707)', () => {
  const aud = async (resource?: string) => {
    const flow = await codeFlow(h, await newClient(), resource ? { resource } : {});
    expect(flow.status, flow.callback.href).toBe(200);
    return jwtVerify(String(flow.json.access_token), jwksOf(), { issuer: ISSUER });
  };

  it('9.3 a request without resource gets https://<host>/mcp', async () => {
    expect((await aud()).payload.aud).toBe(`https://${HOST}/mcp`);
  });

  it('9.3 accepts any URI under /mcp and binds it as the audience', async () => {
    expect((await aud(`https://${HOST}/mcp/e/team-a`)).payload.aud).toBe(
      `https://${HOST}/mcp/e/team-a`,
    );
  });

  it('9.3 accepts https://<host>/api with api scopes', async () => {
    const flow = await codeFlow(h, await newClient(), {
      resource: `https://${HOST}/api`,
      scope: 'api:read api:write',
    });
    expect(flow.status, flow.callback.href).toBe(200);
    const { payload } = await jwtVerify(String(flow.json.access_token), jwksOf(), {
      issuer: ISSUER,
    });
    expect(payload).toMatchObject({ aud: `https://${HOST}/api`, scope: 'api:read api:write' });
  });

  it.each([
    `https://${HOST}/other`,
    'https://evil.example/mcp',
    `https://${HOST}/mcpx`,
    `http://${HOST}/mcp`,
  ])('9.3 rejects the resource %s with invalid_target', async (resource) => {
    const flow = await codeFlow(h, await newClient(), { resource });
    expect(flow.callback.searchParams.get('error')).toBe('invalid_target');
  });
});

describe('9.3 refresh tokens', () => {
  const refresh = (clientId: string, token: string) =>
    tokenRequest(h, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId });

  it('9.3 rotates the refresh token on every use', async () => {
    const clientId = await newClient();
    const first = await codeFlow(h, clientId);
    const rt1 = String(first.json.refresh_token);
    const second = await refresh(clientId, rt1);
    expect(second.status).toBe(200);
    expect(second.json.refresh_token).toBeTruthy();
    expect(second.json.refresh_token).not.toBe(rt1);
    expect(second.json.access_token).toBeTruthy();
  });

  it('9.3 a reused rotated refresh token revokes the whole family', async () => {
    const clientId = await newClient();
    const first = await codeFlow(h, clientId);
    const rt1 = String(first.json.refresh_token);
    const second = await refresh(clientId, rt1);
    const rt2 = String(second.json.refresh_token);
    const reuse = await refresh(clientId, rt1);
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe('invalid_grant');
    const afterRevoke = await refresh(clientId, rt2);
    expect(afterRevoke.json.error).toBe('invalid_grant');
  });

  it('9.3 refresh tokens are opaque', async () => {
    const flow = await codeFlow(h, await newClient());
    expect(String(flow.json.refresh_token).split('.')).toHaveLength(1);
  });

  it('9.3 a refresh token idle for more than 7 days is rejected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const clientId = await newClient();
    const first = await codeFlow(h, clientId);
    vi.setSystemTime(Date.now() + 8 * DAY);
    const result = await refresh(clientId, String(first.json.refresh_token));
    expect(result.json.error).toBe('invalid_grant');
  });

  it('9.3 refreshing within 7 days keeps the grant alive but the 30-day absolute limit ends it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const clientId = await newClient();
    let token = String((await codeFlow(h, clientId)).json.refresh_token);
    for (let i = 0; i < 4; i += 1) {
      vi.setSystemTime(Date.now() + 6 * DAY);
      const result = await refresh(clientId, token);
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      token = String(result.json.refresh_token);
    }
    vi.setSystemTime(Date.now() + 7 * DAY);
    expect((await refresh(clientId, token)).json.error).toBe('invalid_grant');
  });

  it('9.1 a deactivated user cannot refresh', async () => {
    const clientId = await newClient();
    const first = await codeFlow(h, clientId);
    h.inactiveUsers.add('user-1');
    const result = await refresh(clientId, String(first.json.refresh_token));
    expect(result.json.error).toBe('invalid_grant');
  });
});

describe('9.3 consent', () => {
  it('9.3 the consent page shows client name, logo, redirect URI host and scopes (MUST)', async () => {
    const clientId = await newClient({
      client_name: 'Acme Agent',
      logo_uri: 'https://acme.example/logo.png',
    });
    await codeFlow(h, clientId, { scope: 'mcp plugins:read' });
    expect(h.ui.consentViews).toHaveLength(1);
    expect(h.ui.consentViews[0]).toMatchObject({
      clientId,
      clientName: 'Acme Agent',
      logoUri: 'https://acme.example/logo.png',
      redirectUriHost: '127.0.0.1:8765',
      scopes: expect.arrayContaining(['mcp', 'plugins:read']),
    });
  });

  it('9.3 consent is remembered per (user, client): the second authorization shows no page', async () => {
    const clientId = await newClient();
    const browser = h.browser();
    await codeFlow(h, clientId, { browser });
    await codeFlow(h, clientId, { browser });
    expect(h.ui.consentViews).toHaveLength(1);
  });

  it('9.3 the remembered consent is an oidc-provider Grant that expires after 90 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const clientId = await newClient();
    const browser = h.browser();
    await codeFlow(h, clientId, { browser });
    const grant = [...h.models.rows.values()].find((r) => r.type === 'Grant');
    expect(grant?.expiresAt?.getTime()).toBe(Date.now() + 90 * DAY);
    vi.setSystemTime(Date.now() + 91 * DAY);
    const again = await codeFlow(h, clientId, { browser: h.browser() });
    expect(again.status).toBe(200);
    expect(h.ui.consentViews).toHaveLength(2);
  });

  it('9.3 a denied consent returns access_denied with iss', async () => {
    h.ui.consent = 'deny';
    const flow = await codeFlow(h, await newClient());
    expect(flow.callback.searchParams.get('error')).toBe('access_denied');
    expect(flow.callback.searchParams.get('iss')).toBe(ISSUER);
  });

  it('9.3 admins can pre-approve a client: no consent page', async () => {
    const clientId = await newClient();
    await h.policies.upsert({ clientId, preApproved: true, blocked: false });
    const flow = await codeFlow(h, clientId);
    expect(flow.status, flow.callback.href).toBe(200);
    expect(h.ui.consentViews).toHaveLength(0);
  });

  it('9.3 admins can block a client: authorization and refresh fail', async () => {
    const clientId = await newClient();
    const first = await codeFlow(h, clientId);
    await h.policies.upsert({ clientId, preApproved: false, blocked: true });
    const refresh = await tokenRequest(h, {
      grant_type: 'refresh_token',
      refresh_token: String(first.json.refresh_token),
      client_id: clientId,
    });
    expect(refresh.json.error).toBe('invalid_client');
    await expect(codeFlow(h, clientId)).rejects.toThrow(/400/);
  });

  it('9.1 a failed login aborts the authorization with access_denied', async () => {
    h.ui.userId = null;
    const flow = await codeFlow(h, await newClient());
    expect(flow.callback.searchParams.get('error')).toBe('access_denied');
  });
});

describe('9.3 signing keys', () => {
  it('9.3 new tokens use the newest active key; old keys stay in the JWKS until retired', async () => {
    const clientId = await newClient();
    const before = await codeFlow(h, clientId);
    const oldKid = decodeProtectedHeader(String(before.json.access_token)).kid;
    const newKid = h.keys.add(new Date(Date.now() - 1000), new Date(Date.now() + 37 * DAY));
    await h.as.reload();
    const after = await codeFlow(h, clientId);
    expect(decodeProtectedHeader(String(after.json.access_token)).kid).toBe(newKid);
    const jwks = (await (await h.browser().request(`${ISSUER}/jwks`)).json()) as {
      keys: { kid: string }[];
    };
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([oldKid, newKid].sort());
    await jwtVerify(String(before.json.access_token), createLocalJWKSet(jwks as never), {
      issuer: ISSUER,
    });
  });
});
