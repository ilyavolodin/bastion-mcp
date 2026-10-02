import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codeFlow,
  type Harness,
  ISSUER,
  REDIRECT,
  registerClient,
  startHarness,
} from './as-harness';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const dcr = (body: Record<string, unknown>, ip = '203.0.113.7') =>
  h.browser().request(`${ISSUER}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ client_name: 'c', token_endpoint_auth_method: 'none', ...body }),
  });

describe('9.3 Dynamic Client Registration policy (RFC 7591)', () => {
  it.each([
    [['http://127.0.0.1:1234/cb'], 'native'],
    [['http://localhost/cb'], 'native'],
    [['cursor://anysphere.cursor-mcp/oauth/callback'], 'native'],
    [['https://app.example/cb'], 'web'],
    [['https://app.example/cb', 'http://127.0.0.1/cb'], 'web'],
  ])(
    '9.3 a registration without application_type for %j gets %s',
    async (redirect_uris, expected) => {
      const response = await dcr({ redirect_uris });
      expect(response.status).toBe(201);
      expect(((await response.json()) as Record<string, unknown>).application_type).toBe(expected);
    },
  );

  it('9.3 an explicit application_type is kept', async () => {
    const response = await dcr({
      redirect_uris: ['https://app.example/cb'],
      application_type: 'web',
    });
    expect(((await response.json()) as Record<string, unknown>).application_type).toBe('web');
  });

  it.each([
    ['http://app.example/cb'],
    ['javascript:alert(1)'],
    ['https://app.example/cb#frag'],
    ['not a uri'],
    ['https://user:pw@app.example/cb'],
  ])('9.3 rejects the redirect URI %s (https, loopback or private-use only)', async (uri) => {
    const response = await dcr({ redirect_uris: [uri] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_redirect_uri');
  });

  it('9.3 rejects a registration without redirect_uris', async () => {
    expect((await dcr({})).status).toBe(400);
  });

  it('9.3 rejects malformed JSON', async () => {
    const response = await h.browser().request(`${ISSUER}/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(response.status).toBe(400);
  });

  it('9.3 the dcr toggle disables registration', async () => {
    h.settings.dcr = false;
    const response = await dcr({ redirect_uris: [REDIRECT] });
    expect(response.status).toBe(403);
  });

  it('9.3 / 22.5 DCR is rate limited to 10 per IP per hour', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await dcr({ redirect_uris: [REDIRECT] })).status).toBe(201);
    }
    const limited = await dcr({ redirect_uris: [REDIRECT] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect((await dcr({ redirect_uris: [REDIRECT] }, '198.51.100.9')).status).toBe(201);
  });
});

describe('9.3 Client ID Metadata Documents (CIMD)', () => {
  const CLIENT_ID = 'https://app.example/client.json';
  const doc = (overrides: Record<string, unknown> = {}) => ({
    client_id: CLIENT_ID,
    client_name: 'Doc Client',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  });

  it('9.3 resolves a client from its metadata document and shows its name on the consent page', async () => {
    h.cimdDocs.set(CLIENT_ID, doc());
    const flow = await codeFlow(h, CLIENT_ID);
    expect(flow.status, flow.callback.href).toBe(200);
    expect(h.fetchLog).toContain(CLIENT_ID);
    expect(h.ui.consentViews[0]).toMatchObject({ clientName: 'Doc Client' });
  });

  it('9.3 the cimd toggle disables CIMD', async () => {
    h.cimdDocs.set(CLIENT_ID, doc());
    h.settings.cimd = false;
    await expect(codeFlow(h, CLIENT_ID)).rejects.toThrow(/400/);
    expect(h.fetchLog).not.toContain(CLIENT_ID);
  });

  it('9.3 the CIMD host allowlist restricts which hosts are fetched (empty means any https host)', async () => {
    h.cimdDocs.set(CLIENT_ID, doc());
    h.settings.cimdHostAllowlist = ['other.example'];
    await expect(codeFlow(h, CLIENT_ID)).rejects.toThrow(/400/);
    expect(h.fetchLog).not.toContain(CLIENT_ID);
    h.settings.cimdHostAllowlist = ['*.example'];
    expect((await codeFlow(h, CLIENT_ID)).status).toBe(200);
  });

  it('9.3 redirect URIs in a metadata document follow the same policy', async () => {
    h.cimdDocs.set(CLIENT_ID, doc({ redirect_uris: ['http://app.example/cb'] }));
    await expect(codeFlow(h, CLIENT_ID, { redirectUri: 'http://app.example/cb' })).rejects.toThrow(
      /400/,
    );
  });

  it('9.3 a document whose client_id differs from its URL is rejected', async () => {
    h.cimdDocs.set(CLIENT_ID, doc({ client_id: 'https://evil.example/c.json' }));
    await expect(codeFlow(h, CLIENT_ID)).rejects.toThrow(/400/);
  });

  it('9.3 admins can block a CIMD client', async () => {
    h.cimdDocs.set(CLIENT_ID, doc());
    await h.policies.upsert({ clientId: CLIENT_ID, preApproved: false, blocked: true });
    await expect(codeFlow(h, CLIENT_ID)).rejects.toThrow(/400/);
  });
});

describe('17.2 admin pre-registered clients', () => {
  it('9.3 a pre-registered public client can run the code flow', async () => {
    const { clientId } = await h.as.preRegisterClient({
      kind: 'public',
      name: 'Admin client',
      redirectUris: [REDIRECT],
    });
    const flow = await codeFlow(h, clientId);
    expect(flow.status, flow.callback.href).toBe(200);
  });

  it('9.3 refuses redirect URIs outside the policy and the reserved credential client id', async () => {
    await expect(
      h.as.preRegisterClient({
        kind: 'public',
        name: 'x',
        redirectUris: ['http://evil.example/cb'],
      }),
    ).rejects.toThrow(/redirect URIs/);
    await expect(
      h.as.preRegisterClient({
        kind: 'public',
        name: 'x',
        redirectUris: [REDIRECT],
        clientId: 'bastion-credential',
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      h.as.preRegisterClient({ kind: 'service', name: 'x', authMethod: 'private_key_jwt' }),
    ).rejects.toThrow(/jwks/);
  });

  it('9.3 the unauthenticated registration helper still works with a plain DCR client', async () => {
    expect((await registerClient(h)).status).toBe(201);
  });
});
