import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { bootStack, freePort, type Stack } from './helpers/stack';

/**
 * 9.3, 7.1: Bastion evaluated on plain http (`http://localhost:8080`, the docker compose setup) must work with MCP
 * clients such as VS Code. The OAuth issuer, the protected-resource metadata and the accepted `resource` indicator
 * all have to use the scheme clients really use; a guessed `https://` makes the authorization request fail with
 * "resource indicator is missing, or unknown".
 */
describe.skipIf(!haveDocker())('9.3 OAuth on a plain-http public origin', () => {
  let env: TestEnv;
  let stack: Stack;
  let origin: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    stack = await bootStack({
      env,
      vars: { BASTION_PUBLIC_URL: origin, BASTION_HTTP_PORT: String(port) },
    });
  });
  afterAll(async () => {
    await stack?.stop();
    await env?.cleanup();
  });

  const get = (path: string) => fetch(`${origin}${path}`, { redirect: 'manual' });

  it('9.3 the protected resource metadata names the http resource and the http issuer', async () => {
    const res = await get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe(`${origin}/mcp`);
    expect(doc.authorization_servers).toEqual([`${origin}/oauth`]);
  });

  it('9.3 the authorization server metadata uses the http issuer', async () => {
    const res = await get('/.well-known/oauth-authorization-server/oauth');
    const doc = (await res.json()) as { issuer: string; authorization_endpoint: string };
    expect(doc.issuer).toBe(`${origin}/oauth`);
    expect(doc.authorization_endpoint.startsWith(origin)).toBe(true);
  });

  it('9.3 a client registered over DCR can start authorization for the resource it discovered', async () => {
    const redirect = 'http://127.0.0.1:33418/callback';
    const reg = await fetch(`${origin}/oauth/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'VS Code like client',
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      scope: 'mcp',
      state: 'abc',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
    });
    const res = await get(`/oauth/auth?${params}`);
    const location = res.headers.get('location') ?? '';
    // Accepted: the next step is the sign-in interaction, never an error redirect back to the client.
    expect(location).not.toContain('error=');
    expect(location).toContain('/oauth/interaction/');
  });

  it('9.3 a resource on another scheme or host is still refused', async () => {
    const redirect = 'http://127.0.0.1:33418/callback';
    const reg = await fetch(`${origin}/oauth/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'c',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      }),
    });
    const client = (await reg.json()) as { client_id: string };
    for (const resource of ['https://127.0.0.1/mcp', 'http://evil.example/mcp']) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirect,
        scope: 'mcp',
        code_challenge: createHash('sha256').update('v').digest('base64url'),
        code_challenge_method: 'S256',
        resource,
      });
      const res = await get(`/oauth/auth?${params}`);
      expect(res.headers.get('location') ?? '').toContain('error=invalid_target');
    }
  });
});
