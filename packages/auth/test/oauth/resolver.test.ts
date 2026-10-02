import {
  BastionError,
  PolicyDeniedError,
  parseServerSpec,
  type ServerSpec,
  UpstreamAuthRequiredError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdpLogin } from '../../src/oauth/idp/login';
import { IdpTokenVault } from '../../src/oauth/idp/tokens';
import type { IdpConnection } from '../../src/oauth/ports';
import { IdpMintedTokens } from '../../src/oauth/upstream/idp-minted';
import { OAuthConfigError } from '../../src/oauth/upstream/injection';
import { type SecretResolver, UpstreamCredentialResolver } from '../../src/oauth/upstream/resolver';
import { type FakeIdp, startFakeIdp } from './fake-idp';
import { MemoryIdpConnections, MemoryIdpTokens } from './fakes';
import {
  HOST,
  safeLoopbackFetch,
  startUpstreamHarness,
  type UpstreamHarness,
  USER,
} from './upstream-harness';

const IDP_CONNECTION = '11111111-1111-4111-8111-111111111111';
let x: UpstreamHarness;
let idp: FakeIdp;
let resolver: UpstreamCredentialResolver;
let orgSecrets: Map<string, { value: string; version: number }>;
let userSecrets: Map<string, { value: string; version: number }>;
let vault: IdpTokenVault;
let connection: IdpConnection;

const secretResolver: SecretResolver = {
  resolve: async (ref) =>
    (ref.scope === 'org'
      ? orgSecrets.get(ref.name)
      : userSecrets.get(`${ref.ownerId}:${ref.name}`)) ?? null,
};

const remote = (auth: unknown): ServerSpec =>
  parseServerSpec({ type: 'remote', transport: 'streamable-http', url: x.upstream.mcpUrl, auth });
const pkg = (auth: unknown): ServerSpec =>
  parseServerSpec({
    type: 'package',
    runtime: 'npm',
    identifier: 'some-mcp',
    version: '1.2.3',
    auth,
  });
const installation = { id: 'inst-1', name: 'Fake MCP' };
const resolve = (spec: ServerSpec, principal = USER) =>
  resolver.resolve(principal, installation, spec);

beforeEach(async () => {
  x = await startUpstreamHarness();
  idp = await startFakeIdp();
  orgSecrets = new Map();
  userSecrets = new Map();
  connection = {
    id: IDP_CONNECTION,
    name: 'IdP',
    issuer: idp.issuer,
    discoveryUrl: idp.discoveryUrl,
    clientId: idp.clientId,
    clientSecretId: 'idp-secret',
    scopes: ['openid', 'email', 'profile'],
    claimMap: { email: 'email', name: 'name', groups: 'groups', sub: 'sub' },
    emailDomains: [],
    storeRefreshToken: true,
    apiScope: 'api://bastion/user_impersonation',
    enterpriseManagedAuth: true,
    enabled: true,
  };
  x.secrets.byId.set('idp-secret', idp.clientSecret);
  const connections = new MemoryIdpConnections([connection]);
  const login = new IdpLogin({
    host: HOST,
    connections,
    secrets: x.secrets,
    fetch: safeLoopbackFetch(),
    allowInsecureHttp: true,
    clock: x.clock,
    stateKeyring: x.deps.stateKeyring,
  });
  vault = new IdpTokenVault({ store: new MemoryIdpTokens(), secrets: x.secrets, clock: x.clock });
  const start = await login.startLogin(IDP_CONNECTION);
  const done = await login.completeLogin(
    IDP_CONNECTION,
    await idp.authorize(start.authorizationUrl),
    start.stateToken,
  );
  await vault.save('user-1', IDP_CONNECTION, done.tokens);
  const minted = new IdpMintedTokens({
    host: HOST,
    idpClients: login,
    vault,
    broker: x.broker,
    secrets: x.secrets,
    clock: x.clock,
  });
  resolver = new UpstreamCredentialResolver({
    host: HOST,
    secrets: secretResolver,
    broker: x.broker,
    minted,
  });
});
afterEach(async () => {
  await x.close();
  await idp.close();
});

const idpRequests = (grant: string) => idp.requests.filter((r) => r.params.grant_type === grant);

describe('9.5 none, orgSecret, userSecret', () => {
  it('9.5 none injects nothing', async () => {
    const result = await resolve(remote({ mode: 'none' }));
    expect(result.injections).toEqual([]);
    expect(result.expiresAt).toBeNull();
    expect(
      (await resolve(remote({ mode: 'none' }), { type: 'user', id: 'other' })).credentialHash,
    ).toBe(result.credentialHash);
  });

  it('9.5 orgSecret resolves {{secret.*}} templates, shared across users', async () => {
    orgSecrets.set('API_KEY', { value: 'org-key-123', version: 3 });
    const spec = remote({
      mode: 'orgSecret',
      inject: [{ to: 'header', name: 'X-Api-Key', value: 'k {{secret.API_KEY}}' }],
    });
    const a = await resolve(spec);
    expect(a.injections).toEqual([{ to: 'header', name: 'X-Api-Key', value: 'k org-key-123' }]);
    const b = await resolve(spec, { type: 'user', id: 'other' });
    expect(b.credentialHash).toBe(a.credentialHash);
    expect(a.credentialHash).not.toContain('org-key-123');
    orgSecrets.set('API_KEY', { value: 'rotated', version: 4 });
    expect((await resolve(spec)).credentialHash).not.toBe(a.credentialHash);
  });

  it('9.5 the credential hash never depends on the secret value, only on identity and version', async () => {
    const spec = remote({
      mode: 'orgSecret',
      inject: [{ to: 'header', name: 'X', value: '{{secret.K}}' }],
    });
    orgSecrets.set('K', { value: 'one', version: 1 });
    const one = await resolve(spec);
    orgSecrets.set('K', { value: 'two', version: 1 });
    expect((await resolve(spec)).credentialHash).toBe(one.credentialHash);
  });

  it('9.5 a missing org secret is a configuration error, not a user prompt', async () => {
    const spec = remote({
      mode: 'orgSecret',
      inject: [{ to: 'header', name: 'X', value: '{{secret.NOPE}}' }],
    });
    await expect(resolve(spec)).rejects.toBeInstanceOf(OAuthConfigError);
  });

  it('9.5 userSecret injects the user own secret into a package env var, hashed per user', async () => {
    userSecrets.set('user-1:TOKEN', { value: 'pat-1', version: 1 });
    userSecrets.set('user-2:TOKEN', { value: 'pat-2', version: 1 });
    const spec = pkg({
      mode: 'userSecret',
      fields: [{ name: 'TOKEN', label: 'API token' }],
      inject: [{ to: 'env', name: 'SERVICE_TOKEN', value: '{{secret.TOKEN}}' }],
    });
    const a = await resolve(spec);
    expect(a.injections).toEqual([{ to: 'env', name: 'SERVICE_TOKEN', value: 'pat-1' }]);
    const b = await resolve(spec, { type: 'user', id: 'user-2' });
    expect(b.injections[0]).toMatchObject({ value: 'pat-2' });
    expect(b.credentialHash).not.toBe(a.credentialHash);
  });

  it('9.5 / 6.5 a missing userSecret raises -32015 with a connectUrl', async () => {
    const spec = remote({
      mode: 'userSecret',
      fields: [{ name: 'TOKEN', label: 'API token' }],
      inject: [{ to: 'header', name: 'Authorization', value: 'Bearer {{secret.TOKEN}}' }],
    });
    const error = await resolve(spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamAuthRequiredError);
    expect(error).toMatchObject({
      mcpCode: -32015,
      data: { installation: 'inst-1', connectUrl: `https://${HOST}/connect/inst-1` },
    });
  });
});

describe('9.5 / 9.6 oauth mode', () => {
  const spec = () => remote({ mode: 'oauth', client: { registration: 'dcr' }, scopes: ['read'] });

  it('6.5 raises -32015 with the connect URL when the user has not connected', async () => {
    const error = await resolve(spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamAuthRequiredError);
    expect(error).toMatchObject({
      mcpCode: -32015,
      data: { connectUrl: `https://${HOST}/connect/inst-1` },
    });
  });

  it('9.5 injects Authorization: Bearer by default for remote servers', async () => {
    await x.connect();
    const result = await resolve(spec());
    expect(result.injections).toEqual([
      { to: 'header', name: 'Authorization', value: 'Bearer up-at-2' },
    ]);
    expect(result.expiresAt).toBeGreaterThan(x.clock.t);
  });

  it('9.5 the credential hash is stable across refreshes and differs per user', async () => {
    await x.connect();
    const before = await resolve(spec());
    x.clock.t += 3500 * 1000;
    const refreshed = await resolve(spec());
    expect(refreshed.injections[0]).not.toEqual(before.injections[0]);
    expect(refreshed.credentialHash).toBe(before.credentialHash);
    await x.connect({ type: 'user', id: 'user-2' });
    expect((await resolve(spec(), { type: 'user', id: 'user-2' })).credentialHash).not.toBe(
      before.credentialHash,
    );
  });

  it('9.5 a reconnect_required token raises -32015 again', async () => {
    await x.connect();
    x.clock.t += 3500 * 1000;
    x.upstream.behavior.refreshFailure = 'invalid_grant';
    await expect(resolve(spec())).rejects.toBeInstanceOf(UpstreamAuthRequiredError);
  });

  it('9.5 packages inject through an env var with no default', async () => {
    await x.connect();
    const withEnv = pkg({
      mode: 'oauth',
      client: { registration: 'dcr' },
      inject: [{ to: 'env', name: 'GITHUB_TOKEN', value: '{{oauth.accessToken}}' }],
    });
    const result = await resolver.resolve(
      USER,
      { ...installation, upstreamUrl: x.upstream.mcpUrl },
      withEnv,
    );
    expect(result.injections).toEqual([{ to: 'env', name: 'GITHUB_TOKEN', value: 'up-at-2' }]);
    const noInject = pkg({ mode: 'oauth', client: { registration: 'dcr' } });
    await expect(
      resolver.resolve(USER, { ...installation, upstreamUrl: x.upstream.mcpUrl }, noInject),
    ).rejects.toThrow(/packages must declare/);
  });

  it('9.5 a package needs the upstream URL to use oauth', async () => {
    const withEnv = pkg({
      mode: 'oauth',
      client: { registration: 'dcr' },
      inject: [{ to: 'env', name: 'T', value: '{{oauth.accessToken}}' }],
    });
    await expect(resolve(withEnv)).rejects.toThrow(/upstream MCP URL/);
  });

  it('9.3 service accounts cannot use interactive upstream OAuth', async () => {
    await expect(resolve(spec(), { type: 'service', id: 'sa-1' })).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('9.6 an upstream that stops advertising S256 is never silently continued once the token expired', async () => {
    await x.connect();
    x.clock.t += 3700 * 1000;
    x.upstream.behavior.advertiseS256 = false;
    await expect(resolve(spec())).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('9.6 template references other than the credential are rejected as configuration errors', async () => {
    await x.connect();
    const bad = remote({
      mode: 'oauth',
      client: { registration: 'dcr' },
      inject: [{ to: 'header', name: 'X', value: '{{secret.UNKNOWN}}' }],
    });
    await expect(resolve(bad)).rejects.toBeInstanceOf(OAuthConfigError);
  });
});

describe('9.7 enterpriseManaged', () => {
  const spec = () =>
    remote({ mode: 'enterpriseManaged', idpConnectionId: IDP_CONNECTION, scopes: ['read'] });

  it('9.7 exchanges the ID token for an ID-JAG and presents it with the jwt-bearer grant', async () => {
    const result = await resolve(spec());
    expect(result.injections[0]).toMatchObject({ to: 'header', name: 'Authorization' });
    const exchange = idpRequests('urn:ietf:params:oauth:grant-type:token-exchange').at(-1)?.params;
    expect(exchange).toMatchObject({
      requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      audience: x.upstream.origin,
      resource: x.upstream.mcpUrl,
      scope: 'read',
    });
    const bearer = x.upstream.requests.filter((r) => r.path === '/token').at(-1)?.params;
    expect(bearer?.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jag = String(bearer?.assertion);
    expect(decodeProtectedHeader(jag).typ).toBe('oauth-id-jag+jwt');
    expect(decodeJwt(jag)).toMatchObject({
      iss: idp.issuer,
      aud: x.upstream.origin,
      resource: x.upstream.mcpUrl,
    });
    expect(
      String(
        result.injections[0] && 'value' in result.injections[0] ? result.injections[0].value : '',
      ),
    ).toMatch(/^Bearer up-at-/);
  });

  it('9.7 refreshes the IdP tokens first and uses the refreshed ID token', async () => {
    await resolve(spec());
    expect(idpRequests('refresh_token')).toHaveLength(1);
  });

  it('9.7 caches the access token until 60 s before expiry', async () => {
    const first = await resolve(spec());
    const second = await resolve(spec());
    expect(second.injections).toEqual(first.injections);
    expect(idpRequests('urn:ietf:params:oauth:grant-type:token-exchange')).toHaveLength(1);
    x.clock.t += (3600 - 61) * 1000;
    expect((await resolve(spec())).injections).toEqual(first.injections);
    x.clock.t += 2000;
    const third = await resolve(spec());
    expect(third.injections).not.toEqual(first.injections);
    expect(idpRequests('urn:ietf:params:oauth:grant-type:token-exchange')).toHaveLength(2);
  });

  it('9.7 an IdP refresh without an ID token fails with -32015', async () => {
    idp.behavior.emitIdTokenOnRefresh = false;
    const error = await resolve(spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamAuthRequiredError);
    expect(error).toMatchObject({ mcpCode: -32015 });
    expect(idpRequests('urn:ietf:params:oauth:grant-type:token-exchange')).toHaveLength(0);
  });

  it('9.7 an IdP refusal is -32010 with the IdP description, and nothing is cached', async () => {
    idp.behavior.refuseExchange = 'user is not in the allowed group';
    const error = await resolve(spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect(error).toMatchObject({ mcpCode: -32010, message: 'user is not in the allowed group' });
    idp.behavior.refuseExchange = null;
    const ok = await resolve(spec());
    expect(ok.injections).toHaveLength(1);
    expect(idpRequests('urn:ietf:params:oauth:grant-type:token-exchange')).toHaveLength(2);
  });

  it('9.7 an upstream AS refusing the ID-JAG is -32010 with its description', async () => {
    x.upstream.behavior.jwtBearerRefusal = 'tenant is not enrolled';
    await expect(resolve(spec())).rejects.toMatchObject({
      mcpCode: -32010,
      message: 'tenant is not enrolled',
    });
  });

  it('9.7 the connection must store refresh tokens', async () => {
    connection.storeRefreshToken = false;
    await expect(resolve(spec())).rejects.toBeInstanceOf(OAuthConfigError);
  });

  it('9.7 a user without an IdP session must sign in again (-32015)', async () => {
    await expect(resolve(spec(), { type: 'user', id: 'user-no-session' })).rejects.toBeInstanceOf(
      UpstreamAuthRequiredError,
    );
  });

  it('9.7 refuses an upstream AS that does not list the jwt-bearer grant', async () => {
    x.upstream.behavior.grantTypes = ['authorization_code'];
    await expect(resolve(spec())).rejects.toBeInstanceOf(OAuthConfigError);
  });

  it('9.7 a missing or disabled IdP connection is a configuration error', async () => {
    connection.enabled = false;
    await expect(resolve(spec())).rejects.toBeInstanceOf(OAuthConfigError);
  });

  it('9.3 service accounts cannot use enterprise-managed authorization', async () => {
    await expect(resolve(spec(), { type: 'service', id: 'sa-1' })).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('9.7 a revoked IdP session asks the user to sign in again', async () => {
    idp.behavior.refuseRefresh = true;
    await expect(resolve(spec())).rejects.toBeInstanceOf(UpstreamAuthRequiredError);
  });

  it('21.3 an IdP outage fails new minting but cached upstream tokens keep working', async () => {
    const first = await resolve(spec());
    await idp.close();
    expect((await resolve(spec())).injections).toEqual(first.injections);
    x.clock.t += 3600 * 1000;
    const error = await resolve(spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect(error).toBeInstanceOf(BastionError);
    idp = await startFakeIdp();
  });

  it('9.5 the credential hash identifies user, connection and scopes', async () => {
    const a = await resolve(spec());
    const b = await resolve(
      remote({ mode: 'enterpriseManaged', idpConnectionId: IDP_CONNECTION, scopes: ['write'] }),
    );
    expect(a.credentialHash).not.toBe(b.credentialHash);
    expect(a.credentialHash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('9.7 tokenExchange', () => {
  const rfc = () =>
    remote({
      mode: 'tokenExchange',
      idpConnectionId: IDP_CONNECTION,
      flavor: 'rfc8693',
      audience: 'api://internal-mcp',
      scopes: ['mcp.read'],
    });
  const obo = () =>
    remote({
      mode: 'tokenExchange',
      idpConnectionId: IDP_CONNECTION,
      flavor: 'entra-obo',
      audience: 'api://upstream-app',
    });

  it('9.7 rfc8693 exchanges the IdP access token for the configured audience', async () => {
    const result = await resolve(rfc());
    const exchange = idpRequests('urn:ietf:params:oauth:grant-type:token-exchange').at(-1)?.params;
    expect(exchange).toMatchObject({
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: 'api://internal-mcp',
      scope: 'mcp.read',
    });
    expect(String(exchange?.subject_token)).toMatch(/^idp-at-/);
    expect(result.injections[0]).toMatchObject({
      value: expect.stringMatching(/^Bearer exchanged-for-api:\/\/internal-mcp/),
    });
  });

  it('9.7 entra-obo uses the jwt-bearer grant with requested_token_use=on_behalf_of and the .default scope', async () => {
    const result = await resolve(obo());
    const call = idpRequests('urn:ietf:params:oauth:grant-type:jwt-bearer').at(-1)?.params;
    expect(call).toMatchObject({
      requested_token_use: 'on_behalf_of',
      scope: 'api://upstream-app/.default',
    });
    expect(String(call?.assertion)).toMatch(/^idp-at-/);
    expect(result.injections[0]).toMatchObject({ value: expect.stringMatching(/^Bearer obo-/) });
  });

  it('9.7 does not double the /.default suffix', async () => {
    await resolve(
      remote({
        mode: 'tokenExchange',
        idpConnectionId: IDP_CONNECTION,
        flavor: 'entra-obo',
        audience: 'api://x/.default',
      }),
    );
    expect(idpRequests('urn:ietf:params:oauth:grant-type:jwt-bearer').at(-1)?.params.scope).toBe(
      'api://x/.default',
    );
  });

  it('9.7 caches the minted token until 60 s before expiry; a refusal is -32010 and caches nothing', async () => {
    await resolve(obo());
    await resolve(obo());
    expect(idpRequests('urn:ietf:params:oauth:grant-type:jwt-bearer')).toHaveLength(1);
    x.clock.t += 1800 * 1000;
    idp.behavior.refuseExchange = 'conditional access blocked';
    await expect(resolve(obo())).rejects.toMatchObject({
      mcpCode: -32010,
      message: 'conditional access blocked',
    });
    idp.behavior.refuseExchange = null;
    await resolve(obo());
    expect(idpRequests('urn:ietf:params:oauth:grant-type:jwt-bearer')).toHaveLength(3);
  });

  it('9.3 a service account uses only its configured subject token', async () => {
    const sa = { type: 'service' as const, id: 'sa-1' };
    await expect(resolve(rfc(), sa)).rejects.toBeInstanceOf(UpstreamAuthRequiredError);
    const subject = (await vault.load('user-1', IDP_CONNECTION))?.accessToken ?? '';
    await x.secrets.put({ scope: 'user', ownerId: 'sa-1', name: 'subject-token' }, subject);
    const result = await resolve(rfc(), sa);
    expect(result.injections).toHaveLength(1);
    expect(
      idpRequests('urn:ietf:params:oauth:grant-type:token-exchange').at(-1)?.params.subject_token,
    ).toBe(subject);
  });

  it('9.7 a user without an IdP session must sign in again', async () => {
    await expect(resolve(rfc(), { type: 'user', id: 'nobody' })).rejects.toBeInstanceOf(
      UpstreamAuthRequiredError,
    );
  });

  it('9.7 a connection that does not store refresh tokens is a configuration error', async () => {
    connection.storeRefreshToken = false;
    await expect(resolve(rfc())).rejects.toBeInstanceOf(OAuthConfigError);
  });

  it('9.7 a missing IdP connection is a configuration error', async () => {
    connection.enabled = false;
    await expect(resolve(rfc())).rejects.toBeInstanceOf(OAuthConfigError);
  });

  it('21.3 an unreachable IdP is an upstream-unavailable error', async () => {
    x.clock.t += 3700 * 1000;
    await idp.close();
    await expect(resolve(rfc())).rejects.toBeInstanceOf(UpstreamUnavailableError);
    idp = await startFakeIdp();
  });
});
