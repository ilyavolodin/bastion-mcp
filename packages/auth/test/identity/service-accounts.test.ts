import { generateEs256KeyPair } from '@bastion-mcp/secrets';
import { describe, expect, it } from 'vitest';
import {
  assertUpstreamAuthAllowed,
  authenticateClientSecret,
  buildPrincipal,
  createServiceAccount,
  hashClientSecret,
  IdentityValidationError,
  InteractiveOAuthNotAllowedError,
  rotateClientSecret,
  type ServiceAccount,
  type ServiceAccountClient,
  type ServiceAccountDirectory,
  serviceAccountPrincipal,
  upstreamAuthModeAllowed,
  validateClientJwks,
  verifyClientSecret,
} from '../../src/identity';
import { FakeClock } from './helpers';

class MemoryDirectory implements ServiceAccountDirectory {
  accounts = new Map<string, ServiceAccount>();
  clients = new Map<string, ServiceAccountClient>();
  async findByClientId(clientId: string) {
    const client = this.clients.get(clientId);
    const account = client ? this.accounts.get(client.serviceAccountId) : undefined;
    return client && account ? { account, client } : null;
  }
  async findById(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async listByTeam(teamId: string) {
    return [...this.accounts.values()].filter((a) => a.teamId === teamId);
  }
  async create(account: ServiceAccount, client: ServiceAccountClient) {
    this.accounts.set(account.id, account);
    this.clients.set(client.clientId, client);
  }
  async saveClient(client: ServiceAccountClient) {
    this.clients.set(client.clientId, client);
  }
  async setStatus(id: string, status: ServiceAccount['status']) {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, status });
  }
}

const input = {
  teamId: 'team-1',
  slug: 'ci-bot',
  displayName: 'CI bot',
  authMethod: 'client_secret_basic' as const,
};

describe('9.3 service accounts', () => {
  it('9.3 creates a team-owned service account with a client_secret_basic client; the secret is returned once', async () => {
    const directory = new MemoryDirectory();
    const created = await createServiceAccount({ directory, clock: new FakeClock() }, input);
    expect(created.account).toMatchObject({ teamId: 'team-1', slug: 'ci-bot', status: 'active' });
    expect(created.account.oauthClientId).toBe(created.client.clientId);
    expect(created.clientSecret).toMatch(/^bst_sec_[0-9A-Za-z]{43}$/);
    expect(JSON.stringify([...directory.clients.values()])).not.toContain(created.clientSecret);
    expect(created.client.secretSha256).toBe(hashClientSecret(created.clientSecret ?? ''));
  });

  it('9.3 verifies the secret in constant time and authenticates only active accounts', async () => {
    const directory = new MemoryDirectory();
    const { client, clientSecret, account } = await createServiceAccount({ directory }, input);
    expect(verifyClientSecret(client, clientSecret ?? '')).toBe(true);
    expect(verifyClientSecret(client, 'wrong')).toBe(false);
    expect(verifyClientSecret({ secretSha256: null }, 'x')).toBe(false);
    expect(
      await authenticateClientSecret(directory, client.clientId, clientSecret ?? ''),
    ).toMatchObject({ id: account.id });
    expect(await authenticateClientSecret(directory, client.clientId, 'wrong')).toBeNull();
    expect(await authenticateClientSecret(directory, 'unknown', 'x')).toBeNull();
    await directory.setStatus(account.id, 'disabled');
    expect(
      await authenticateClientSecret(directory, client.clientId, clientSecret ?? ''),
    ).toBeNull();
  });

  it('9.3 rotating the secret invalidates the old one', async () => {
    const directory = new MemoryDirectory();
    const { client, clientSecret } = await createServiceAccount({ directory }, input);
    const fresh = await rotateClientSecret({ directory }, client.clientId);
    expect(fresh).not.toBe(clientSecret);
    expect(
      await authenticateClientSecret(directory, client.clientId, clientSecret ?? ''),
    ).toBeNull();
    expect(await authenticateClientSecret(directory, client.clientId, fresh ?? '')).not.toBeNull();
    expect(await rotateClientSecret({ directory }, 'unknown')).toBeNull();
  });

  it('9.3 private_key_jwt accepts public keys only', async () => {
    const directory = new MemoryDirectory();
    const pair = generateEs256KeyPair();
    const created = await createServiceAccount(
      { directory },
      { ...input, slug: 'jwt-bot', authMethod: 'private_key_jwt', jwks: [pair.publicJwk] },
    );
    expect(created.clientSecret).toBeUndefined();
    expect(created.client).toMatchObject({ authMethod: 'private_key_jwt', secretSha256: null });
    await expect(
      authenticateClientSecret(directory, created.client.clientId, 'x'),
    ).resolves.toBeNull();
    await expect(rotateClientSecret({ directory }, created.client.clientId)).resolves.toBeNull();
    expect(() => validateClientJwks([pair.privateJwk])).toThrow(IdentityValidationError);
    expect(() => validateClientJwks([])).toThrow(IdentityValidationError);
    expect(() => validateClientJwks([{ kty: 'oct', k: 'x' }])).toThrow(IdentityValidationError);
    expect(() => validateClientJwks(undefined)).toThrow(IdentityValidationError);
    await expect(
      createServiceAccount({ directory }, { ...input, authMethod: 'private_key_jwt' }),
    ).rejects.toBeInstanceOf(IdentityValidationError);
  });

  it('9.3 rejects invalid slugs and names', async () => {
    const directory = new MemoryDirectory();
    await expect(
      createServiceAccount({ directory }, { ...input, slug: 'Bad Slug' }),
    ).rejects.toBeInstanceOf(IdentityValidationError);
    await expect(
      createServiceAccount({ directory }, { ...input, displayName: ' ' }),
    ).rejects.toBeInstanceOf(IdentityValidationError);
  });

  it('10.1 the principal record is a service member of its team and inactive when disabled', async () => {
    const directory = new MemoryDirectory();
    const { account } = await createServiceAccount({ directory }, input);
    expect(serviceAccountPrincipal(account)).toEqual({
      id: account.id,
      type: 'service',
      orgRole: 'member',
      teams: [{ teamId: 'team-1', role: 'member' }],
      active: true,
    });
    expect(serviceAccountPrincipal({ ...account, status: 'disabled' }).active).toBe(false);
  });

  it('9.3 service accounts cannot use interactive upstream OAuth modes', () => {
    const svc = buildPrincipal(
      serviceAccountPrincipal({
        id: 's',
        teamId: 't',
        slug: 'x',
        displayName: 'x',
        status: 'active',
        oauthClientId: null,
        createdAt: new Date(),
      }),
      { authMethod: 'oauth', scopes: ['mcp'] },
    );
    expect(upstreamAuthModeAllowed(svc, 'oauth')).toBe(false);
    expect(upstreamAuthModeAllowed(svc, 'enterpriseManaged')).toBe(false);
    expect(upstreamAuthModeAllowed(svc, 'tokenExchange')).toBe(false);
    expect(upstreamAuthModeAllowed(svc, 'tokenExchange', { subjectTokenConfigured: true })).toBe(
      true,
    );
    for (const m of ['none', 'orgSecret', 'userSecret'] as const)
      expect(upstreamAuthModeAllowed(svc, m)).toBe(true);
    expect(() => assertUpstreamAuthAllowed(svc, 'oauth')).toThrow(InteractiveOAuthNotAllowedError);
    expect(() => assertUpstreamAuthAllowed(svc, 'orgSecret')).not.toThrow();
    expect(upstreamAuthModeAllowed({ type: 'user' }, 'oauth')).toBe(true);
  });
});

describe('9.3 private_key_jwt key strength', () => {
  const modulus = (bits: number) => Buffer.alloc(bits / 8, 0xff).toString('base64url');
  it('9.3 rejects RSA keys under 2048 bits and algs other than RS256/ES256', () => {
    expect(() => validateClientJwks([{ kty: 'RSA', n: modulus(1024), e: 'AQAB' }])).toThrow(
      IdentityValidationError,
    );
    expect(validateClientJwks([{ kty: 'RSA', n: modulus(2048), e: 'AQAB' }])).toHaveLength(1);
    expect(() =>
      validateClientJwks([{ kty: 'RSA', n: modulus(2048), e: 'AQAB', alg: 'RS1' }]),
    ).toThrow(IdentityValidationError);
    expect(() =>
      validateClientJwks([{ kty: 'RSA', n: modulus(2048), e: 'AQAB', alg: 'HS256' }]),
    ).toThrow(IdentityValidationError);
    expect(
      validateClientJwks([{ kty: 'RSA', n: modulus(2048), e: 'AQAB', alg: 'RS256' }]),
    ).toHaveLength(1);
  });
});
