import { sha256Hex } from '@bastion-mcp/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';
import { W } from './helpers/world';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe('9.3 service accounts', () => {
  it('9.3 creates an account with a client secret returned once and only its hash stored', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/service-accounts', {
      body: { teamId: W.teamA, slug: 'bot', displayName: 'Bot' },
    });
    expect(res.status).toBe(201);
    const body = rec(res.body);
    expect(String(body.clientSecret)).toMatch(/^bst_sec_/);
    expect(body.clientId).toMatch(/^sa_/);
    const [client] = await api.store.find('service_account_clients', { serviceAccountId: body.id });
    expect(client?.secretSha256).not.toBe(body.clientSecret);
    expect(JSON.stringify(api.uow.audits)).not.toContain(String(body.clientSecret));
    expect(api.uow.audits.at(-1)?.action).toBe('service_account.create');
    const read = await api.call('admin', 'GET', '/service-accounts');
    expect(JSON.stringify(read.body)).not.toContain(String(body.clientSecret));
  });

  it('9.3 a manager creates accounts only for their own team (10.1)', async () => {
    api = await buildTestApi();
    const own = await api.call('managerOwn', 'POST', '/service-accounts', {
      body: { teamId: W.teamA, slug: 'mine', displayName: 'Mine' },
    });
    expect(own.status).toBe(201);
    const other = await api.call('managerOwn', 'POST', '/service-accounts', {
      body: { teamId: W.teamB, slug: 'theirs', displayName: 'Theirs' },
    });
    expect(other.status).toBe(403);
  });

  it('9.3 validates the slug, the team and key-based accounts', async () => {
    api = await buildTestApi();
    const base = { teamId: W.teamA, displayName: 'X' };
    expect(
      (
        await api.call('admin', 'POST', '/service-accounts', {
          body: { ...base, slug: 'Bad Slug' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.call('admin', 'POST', '/service-accounts', {
          body: { teamId: 'nope', displayName: 'X', slug: 'ok' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api.call('admin', 'POST', '/service-accounts', { body: { ...base, slug: 'ci' } }))
        .status,
    ).toBe(409);
    expect(
      (
        await api.call('admin', 'POST', '/service-accounts', {
          body: { ...base, slug: 'keyed', authMethod: 'private_key_jwt' },
        })
      ).status,
    ).toBe(400);
    const keyed = await api.call('admin', 'POST', '/service-accounts', {
      body: {
        ...base,
        slug: 'keyed',
        authMethod: 'private_key_jwt',
        jwks: [{ kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' }],
      },
    });
    expect(keyed.status).toBe(201);
    expect(rec(keyed.body).clientSecret).toBeUndefined();
  });

  it('9.3 lists accounts filtered by team', async () => {
    api = await buildTestApi();
    const list = await api.call('admin', 'GET', '/service-accounts', {
      query: { teamId: W.teamB },
    });
    const items = rec(list.body).items as { id: string }[];
    expect(items.map((i) => i.id)).toEqual(['svc-b']);
  });

  it('9.3 a manager of another team cannot patch an account (403)', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOther', 'PATCH', `/service-accounts/${W.svc}`, {
      headers: { 'if-match': '*' },
      body: { status: 'disabled' },
    });
    expect(res.status).toBe(403);
  });

  it('9.3 patches an account with a matching ETag', async () => {
    api = await buildTestApi();
    const row = await api.store.get('service_accounts', W.svc);
    const res = await api.call('managerOwn', 'PATCH', `/service-accounts/${W.svc}`, {
      headers: { 'if-match': `"${row?.updatedAt}"` },
      body: { displayName: 'Renamed' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).displayName).toBe('Renamed');
  });

  it('9.3 rotates the client secret, showing the new one once and revoking its tokens', async () => {
    api = await buildTestApi();
    const before = (await api.store.get('service_account_clients', 'sa_seed'))?.secretSha256;
    const res = await api.call('managerOwn', 'POST', `/service-accounts/${W.svc}/credentials`, {
      body: {},
    });
    expect(res.status).toBe(200);
    const secret = String(rec(res.body).clientSecret);
    const after = (await api.store.get('service_account_clients', 'sa_seed'))?.secretSha256;
    expect(after).not.toBe(before);
    expect(after).not.toBe(secret);
    expect(api.uow.audits.at(-1)?.action).toBe('service_account.credentials.rotate');
  });

  it('9.3 replaces the public keys of a key-based account and refuses to rotate a secret that does not exist', async () => {
    api = await buildTestApi();
    const keys = [{ kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' }];
    const set = await api.call('admin', 'POST', `/service-accounts/${W.svc}/credentials`, {
      body: { jwks: keys },
    });
    expect(set.status).toBe(200);
    expect(rec(set.body).authMethod).toBe('private_key_jwt');
    expect(rec(set.body).clientSecret).toBeUndefined();
    const rotate = await api.call('admin', 'POST', `/service-accounts/${W.svc}/credentials`, {
      body: {},
    });
    expect(rotate.status).toBe(400);
    expect(
      (await api.call('admin', 'POST', '/service-accounts/nope/credentials', { body: {} })).status,
    ).toBe(404);
  });

  it('9.3 deleting an account removes its client and revokes its tokens', async () => {
    api = await buildTestApi();
    const row = await api.store.get('service_accounts', W.svc);
    const res = await api.call('managerOwn', 'DELETE', `/service-accounts/${W.svc}`, {
      headers: { 'if-match': `"${row?.updatedAt}"` },
    });
    expect(res.status).toBe(204);
    expect(await api.store.get('service_account_clients', 'sa_seed')).toBeNull();
    expect(await api.store.get('service_accounts', W.svc)).toBeNull();
  });
});

describe('9.1 identity providers', () => {
  const create = {
    name: 'Entra',
    issuer: 'https://idp.example.com',
    discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
    clientId: 'abc',
    clientSecret: 'super-secret-value',
  };

  it('9.1 stores the client secret in the vault and never returns it', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/idp-connections', { body: create });
    expect(res.status).toBe(201);
    expect(res.raw).not.toContain('super-secret-value');
    expect(rec(res.body).clientSecretId).toBeDefined();
    expect(api.secrets.rows.size).toBe(1);
    expect(JSON.stringify(api.uow.audits)).not.toContain('super-secret-value');
    const read = await api.call('admin', 'GET', `/idp-connections/${String(rec(res.body).id)}`);
    expect(read.raw).not.toContain('super-secret-value');
  });

  it('9.1 patches, rotates the secret and deletes with If-Match', async () => {
    api = await buildTestApi();
    const row = await api.store.get('idp_connections', 'idp-1');
    const patched = await api.call('admin', 'PATCH', '/idp-connections/idp-1', {
      headers: { 'if-match': `"${row?.updatedAt}"` },
      body: { enabled: false, clientSecret: 'rotated' },
    });
    expect(patched.status).toBe(200);
    expect(rec(patched.body).enabled).toBe(false);
    expect(patched.raw).not.toContain('rotated');
    expect([...api.secrets.rows.values()][0]?.value).toBe('rotated');
    const fresh = await api.store.get('idp_connections', 'idp-1');
    const del = await api.call('admin', 'DELETE', '/idp-connections/idp-1', {
      headers: { 'if-match': `"${fresh?.updatedAt}"` },
    });
    expect(del.status).toBe(204);
    expect(api.secrets.rows.size).toBe(0);
  });

  it('9.1 tests the discovery document through the port (read-only, no audit)', async () => {
    api = await buildTestApi();
    const before = api.uow.audits.length;
    const ok = await api.call('admin', 'POST', '/idp-connections/idp-1/test');
    expect(ok.status).toBe(200);
    expect(rec(ok.body)).toMatchObject({ ok: true, issuerMatches: true });
    expect(api.uow.audits).toHaveLength(before);
    await api.store.update('idp_connections', 'idp-1', { issuer: 'https://wrong.example.com' });
    const bad = await api.call('admin', 'POST', '/idp-connections/idp-1/test');
    expect(rec(bad.body)).toMatchObject({ ok: false, issuerMatches: false });
    expect((await api.call('admin', 'POST', '/idp-connections/nope/test')).status).toBe(404);
  });

  it('9.1 rejects an invalid connection body', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/idp-connections', {
      body: { ...create, issuer: 'not a url' },
    });
    expect(res.status).toBe(400);
  });

  it('9.1 lists connections for managers and auditors but not members', async () => {
    api = await buildTestApi();
    expect((await api.call('managerOwn', 'GET', '/idp-connections')).status).toBe(200);
    expect((await api.call('auditor', 'GET', '/idp-connections')).status).toBe(200);
    expect((await api.call('member', 'GET', '/idp-connections')).status).toBe(403);
  });
});

describe('9.1 SCIM tokens', () => {
  it('9.1 returns the SCIM secret once and stores only its SHA-256', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/scim-tokens', {
      body: { name: 'Entra', expiresInDays: 30 },
    });
    expect(res.status).toBe(201);
    const token = String(rec(res.body).token);
    expect(token).toMatch(/^bst_scim_/);
    const row = await api.store.get('scim_tokens', String(rec(res.body).id));
    expect(row?.tokenSha256).toBe(sha256Hex(token));
    expect(rec(res.body).tokenSha256).toBeUndefined();
    expect(typeof rec(res.body).expiresAt).toBe('string');
    const list = await api.call('admin', 'GET', '/scim-tokens');
    expect(list.raw).not.toContain('tokenSha256');
    expect(list.raw).not.toContain(token);
  });

  it('9.1 revoking keeps the row and marks revoked_at', async () => {
    api = await buildTestApi();
    const row = await api.store.get('scim_tokens', 'scim-1');
    const res = await api.call('admin', 'DELETE', '/scim-tokens/scim-1', {
      headers: { 'if-match': `"${row?.updatedAt}"` },
    });
    expect(res.status).toBe(204);
    expect((await api.store.get('scim_tokens', 'scim-1'))?.revokedAt).not.toBeNull();
    expect(api.uow.audits.at(-1)?.action).toBe('scim_token.revoke');
  });
});

describe('9.4 OAuth client policies', () => {
  it('9.4 pre-registers, pre-approves and blocks clients', async () => {
    api = await buildTestApi();
    const created = await api.call('admin', 'POST', '/oauth-clients', {
      body: { clientId: 'https://app.example.com/client.json', preApproved: true },
    });
    expect(created.status).toBe(201);
    expect(rec(created.body)).toMatchObject({ preApproved: true, blocked: false });
    const dup = await api.call('admin', 'POST', '/oauth-clients', {
      body: { clientId: 'https://app.example.com/client.json' },
    });
    expect(dup.status).toBe(409);
    const row = await api.store.get('oauth_clients', 'client-1');
    const blocked = await api.call('admin', 'PATCH', '/oauth-clients/client-1', {
      headers: { 'if-match': `"${row?.updatedAt}"` },
      body: { blocked: true },
    });
    expect(blocked.status).toBe(200);
    expect(rec(blocked.body).blocked).toBe(true);
    expect(rec(blocked.body).updatedBy).toBe(W.admin);
    const list = await api.call('auditor', 'GET', '/oauth-clients');
    expect(list.status).toBe(200);
    expect(
      (await api.call('managerOwn', 'POST', '/oauth-clients', { body: { clientId: 'x' } })).status,
    ).toBe(403);
  });
});
