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

const newClient = async () => String((await registerClient(h, {})).json.client_id);

describe('9.3 the AS request listener maps public paths to the provider', () => {
  it('9.3 serves the RFC 8414 path-form document as the OIDC discovery document', async () => {
    const browser = h.browser();
    const a = await browser.request(`https://${HOST}/.well-known/oauth-authorization-server/oauth`);
    const b = await browser.request(`${ISSUER}/.well-known/openid-configuration`);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });

  it('9.3 answers any path outside /oauth with the 404 not_found JSON of the listener', async () => {
    for (const path of [
      '/',
      '/oauthx',
      '/oauthx/token',
      '/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      const response = await h.browser().request(`https://${HOST}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toBe('application/json');
      expect(await response.text(), path).toBe('{"error":"not_found"}');
    }
  });

  it('9.3 maps /oauth and /oauth/ to the provider root, which is not a route of its own', async () => {
    const bare = await h.browser().request(`${ISSUER}`);
    const slash = await h.browser().request(`${ISSUER}/`);
    expect(bare.status).toBe(slash.status);
    expect(bare.status).toBe(404);
    expect(await bare.text()).toBe(await slash.text());
  });

  it('9.3 keeps the query string when it rewrites the path', async () => {
    const response = await h
      .browser()
      .request(`${ISSUER}/auth?client_id=nobody&response_type=code`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('9.3 the pre-approved grant keeps only the scopes the AS knows', () => {
  it('9.3 a pre-approved client keeps only the scopes its client may use: unknown ones and offline_access (no refresh grant) are dropped', async () => {
    const clientId = await newClient();
    await h.policies.upsert({ clientId, preApproved: true, blocked: false });
    const flow = await codeFlow(h, clientId, { scope: 'mcp offline_access bogus:scope' });
    expect(flow.status, JSON.stringify(flow.json)).toBe(200);
    expect(h.ui.consentViews).toHaveLength(0);
    const granted = String(flow.json.scope).split(' ').sort();
    expect(granted).toEqual(['mcp']);
  });

  it('9.3 a pre-approved client still goes through the login confirmation each time', async () => {
    const clientId = await newClient();
    await h.policies.upsert({ clientId, preApproved: true, blocked: false });
    const browser = h.browser();
    await codeFlow(h, clientId, { browser });
    await codeFlow(h, clientId, { browser });
    expect(h.ui.logins).toBe(2);
    expect(h.ui.consentViews).toHaveLength(0);
  });

  it('9.3 remembered consent is reused but the account is confirmed on every request', async () => {
    const clientId = await newClient();
    const browser = h.browser();
    await codeFlow(h, clientId, { browser });
    await codeFlow(h, clientId, { browser });
    expect(h.ui.consentViews).toHaveLength(1);
    expect(h.ui.logins).toBe(2);
  });

  it('9.3 a client that is not pre-approved sees the consent page', async () => {
    const clientId = await newClient();
    await codeFlow(h, clientId);
    expect(h.ui.consentViews).toHaveLength(1);
  });
});

describe('9.3 token lifetimes named in the provider configuration', () => {
  const redeem = async (clientId: string, advanceMs: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { verifier, challenge } = pkcePair();
    const callback = await h.browser().authorize({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
      state: 'st',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    vi.setSystemTime(Date.now() + advanceMs);
    return tokenRequest(h, {
      grant_type: 'authorization_code',
      code: String(callback.searchParams.get('code')),
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
  };

  it('9.3 an authorization code redeems within 60 seconds', async () => {
    expect((await redeem(await newClient(), 55_000)).status).toBe(200);
  });

  it('9.3 an authorization code expires after 60 seconds', async () => {
    const result = await redeem(await newClient(), 65_000);
    expect(result.json.error).toBe('invalid_grant');
  });
});
