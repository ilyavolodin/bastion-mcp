import { createHash, randomBytes } from 'node:crypto';
import { AuthenticationError } from '@bastion-mcp/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haveDocker } from './helpers/env';
import { PUBLIC_ORIGIN, startUiHarness, type UiHarness } from './helpers/ui-harness';

const REDIRECT = 'http://127.0.0.1:8765/callback';
const csrfOf = (html: string): string => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

type Tokens = { access_token: string; refresh_token?: string; token_type: string; scope: string };

describe.skipIf(!haveDocker())('9.3 embedded authorization server and token verification', () => {
  let h: UiHarness;
  beforeAll(async () => {
    h = await startUiHarness({ idpConnection: true });
  });
  afterAll(async () => {
    await h.close();
  });

  const register = async (name: string): Promise<string> => {
    const res = await h.fetch(`${PUBLIC_ORIGIN}/oauth/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  };

  /** Runs the whole browser flow (login through the IdP, consent) and returns the tokens. */
  const authorize = async (
    clientId: string,
    scope = 'mcp offline_access',
    b = h.browser(),
  ): Promise<{ tokens: Tokens; consentHtml: string | undefined }> => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope,
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${PUBLIC_ORIGIN}/mcp`,
    });
    let step = await b.follow(`${PUBLIC_ORIGIN}/oauth/auth?${query}`);
    let consentHtml: string | undefined;
    // 1. the login page: pick the IdP; the IdP callback returns to the interaction
    if (step.response.status === 200 && step.url.includes('/oauth/interaction/')) {
      const html = await step.response.text();
      const link = /href="(\/auth\/login\?[^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
      if (link) step = await b.follow(`${PUBLIC_ORIGIN}${link}`);
      else throw new Error(`no login link in ${html}`);
    }
    // 2. consent
    if (step.response.status === 200) {
      consentHtml = await step.response.text();
      const uid = /\/oauth\/interaction\/([^/"]+)\/consent/.exec(consentHtml)?.[1];
      step = await b.follow(`${PUBLIC_ORIGIN}/oauth/interaction/${uid}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrfOf(consentHtml), decision: 'approve' }),
      });
    }
    const back = new URL(step.url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(`${PUBLIC_ORIGIN}/oauth`);
    const code = back.searchParams.get('code') ?? '';
    const token = await h.fetch(`${PUBLIC_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${PUBLIC_ORIGIN}/mcp`,
      }),
    });
    expect(token.status).toBe(200);
    return { tokens: (await token.json()) as Tokens, consentHtml };
  };

  it('9.3 publishes RFC 8414 metadata at the path-form well-known URL with CORS', async () => {
    const res = await h.fetch(`${PUBLIC_ORIGIN}/.well-known/oauth-authorization-server/oauth`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(`${PUBLIC_ORIGIN}/oauth`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.registration_endpoint).toBeTruthy();
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('9.3 DCR + PKCE + IdP login + consent yields an access token the verifier accepts for /mcp', async () => {
    const clientId = await register('Test MCP client');
    const { tokens, consentHtml } = await authorize(clientId);
    // MUST: the consent page shows the client name, the redirect host and the scopes
    expect(consentHtml).toContain('Test MCP client');
    expect(consentHtml).toContain('127.0.0.1:8765');
    expect(consentHtml).toMatch(/<code[^>]*>mcp<\/code>/);
    expect(consentHtml).toMatch(/<strong[^>]*>127\.0\.0\.1:8765<\/strong>/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.refresh_token).toBeTruthy();
    const principal = await h.auth.verifier.verify(
      `Bearer ${tokens.access_token}`,
      `${PUBLIC_ORIGIN}/mcp`,
    );
    expect(principal.authMethod).toBe('oauth');
    expect(principal.clientId).toBe(clientId);
    expect(principal.scopes).toContain('mcp');
    const user = await h.infra.repos.users.findByEmail('ada@acme.example');
    expect(principal.id).toBe(user?.id);
    // audience separation: an MCP token does not open the management API (9.3)
    await expect(
      h.auth.verifier.verify(`Bearer ${tokens.access_token}`, `${PUBLIC_ORIGIN}/api/v1/me`),
    ).rejects.toThrow();
  });

  it('9.3 consent is remembered for the client: the second authorization skips the consent page', async () => {
    const clientId = await register('Remembering client');
    const browser = h.browser();
    const first = await authorize(clientId, 'mcp offline_access', browser);
    expect(first.consentHtml).toBeDefined();
    const second = await authorize(clientId, 'mcp offline_access', browser);
    expect(second.consentHtml).toBeUndefined();
    expect(second.tokens.access_token).not.toBe(first.tokens.access_token);
  });

  it('9.3 denying consent returns access_denied to the client', async () => {
    const clientId = await register('Denied client');
    const verifier = randomBytes(32).toString('base64url');
    const b = h.browser();
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
      state: 's',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    let step = await b.follow(`${PUBLIC_ORIGIN}/oauth/auth?${query}`);
    const login = /href="(\/auth\/login\?[^"]+)"/
      .exec(await step.response.text())?.[1]
      ?.replaceAll('&amp;', '&');
    step = await b.follow(`${PUBLIC_ORIGIN}${login}`);
    const html = await step.response.text();
    const uid = /\/oauth\/interaction\/([^/"]+)\/consent/.exec(html)?.[1];
    step = await b.follow(`${PUBLIC_ORIGIN}/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfOf(html), decision: 'deny' }),
    });
    expect(new URL(step.url).searchParams.get('error')).toBe('access_denied');
  });

  it('9.3 the consent form refuses a missing CSRF token', async () => {
    const clientId = await register('Csrf client');
    const verifier = randomBytes(32).toString('base64url');
    const b = h.browser();
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    let step = await b.follow(`${PUBLIC_ORIGIN}/oauth/auth?${query}`);
    const login = /href="(\/auth\/login\?[^"]+)"/
      .exec(await step.response.text())?.[1]
      ?.replaceAll('&amp;', '&');
    step = await b.follow(`${PUBLIC_ORIGIN}${login}`);
    const html = await step.response.text();
    const uid = /\/oauth\/interaction\/([^/"]+)\/consent/.exec(html)?.[1];
    const res = await b.request(`${PUBLIC_ORIGIN}/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'approve' }),
    });
    expect(res.status).toBe(403);
  });

  it('9.3 PATs authenticate by SHA-256 lookup and a revoked PAT stops working after revocation', async () => {
    const user = await h.infra.repos.users.findByEmail('ada@acme.example');
    expect(user).not.toBeNull();
    const { token, record } = await h.auth.pats.create({
      principalId: user?.id ?? '',
      principalType: 'user',
      name: 'ci',
      scopes: ['mcp'],
    });
    expect(token.startsWith('bst_pat_')).toBe(true);
    const principal = await h.auth.verifier.verify(`Bearer ${token}`, `${PUBLIC_ORIGIN}/mcp`);
    expect(principal.authMethod).toBe('pat');
    expect(principal.credentialId).toBe(record.id);
    await h.auth.pats.revoke(record.id, { ownerId: user?.id ?? '' });
    await new Promise((r) => setTimeout(r, 300));
    await expect(
      h.auth.verifier.verify(`Bearer ${token}`, `${PUBLIC_ORIGIN}/mcp`),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('9.1 deactivation revokes access tokens at once: the watermark rejects them within the cache window', async () => {
    const clientId = await register('Revoked client');
    const { tokens } = await authorize(clientId);
    const header = `Bearer ${tokens.access_token}`;
    const before = await h.auth.verifier.verify(header, `${PUBLIC_ORIGIN}/mcp`);
    await h.auth.deactivation.execute({ type: 'revoke_tokens', principalId: before.id });
    // the principal cache is evicted through bastion:revoke; no wait for the 60 s TTL
    await new Promise((r) => setTimeout(r, 300));
    await expect(h.auth.verifier.verify(header, `${PUBLIC_ORIGIN}/mcp`)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });
});
