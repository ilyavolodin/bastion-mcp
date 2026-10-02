import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/audit';
import {
  createIdpConnectionRepository,
  createIdpTokenStore,
  createKeyStore,
  createOAuthClientPolicyRepository,
  createOidcModelStore,
  createPatRepository,
  createScimTokenRepository,
  createSecretRepository,
  createServiceAccountRepository,
  createTeamRepository,
  createUpstreamClientStore,
  createUpstreamTokenStore,
  createUserRepository,
  etagOf,
  type SecretCodec,
  type SecretKey,
  type SecretMetadata,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const audit = { actorType: 'user', actorId: newId() } as const;

describe.skipIf(!dbEnabled())('16.2 token, OAuth, IdP and secret stores', () => {
  const h = useTestDb();

  const seedUser = async (email: string) =>
    createUserRepository(h.db.prisma).create({ email, displayName: email });

  it('9.3 PATs: insert by hash, lookup, revoke, revoke-all, batched last-used never moves backwards', async () => {
    const pats = createPatRepository(h.db.prisma);
    const u = await seedUser('pat@acme.com');
    const mk = (name: string) => ({
      id: newId(),
      principalType: 'user' as const,
      principalId: u.id,
      name,
      tokenSha256: sha(name),
      scopes: ['mcp:use'],
      endpointId: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    const a = mk('a');
    const b = mk('b');
    await pats.insert(a, audit);
    await pats.insert(b);
    await expect(pats.insert({ ...mk('c'), tokenSha256: a.tokenSha256 })).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(await pats.findByHash(a.tokenSha256)).toMatchObject({ id: a.id, scopes: ['mcp:use'] });
    expect(await pats.findById(b.id)).toMatchObject({ name: 'b' });
    expect(await pats.findByHash(sha('unknown'))).toBeNull();
    expect((await pats.listByPrincipal(u.id)).map((p) => p.name).sort()).toEqual(['a', 'b']);

    const later = new Date(Date.now() + 5_000);
    await pats.touchLastUsed([
      { id: a.id, at: later },
      { id: b.id, at: new Date(Date.now() - 60_000) },
    ]);
    await pats.touchLastUsed([{ id: a.id, at: new Date(Date.now() - 120_000) }]);
    await pats.touchLastUsed([]);
    expect((await pats.findById(a.id))?.lastUsedAt?.getTime()).toBe(later.getTime());

    await pats.markRevoked(a.id, new Date(), audit);
    await pats.markRevoked(a.id, new Date(), audit);
    expect((await pats.findById(a.id))?.revokedAt).not.toBeNull();
    const revoked = await pats.revokeAllForPrincipal(u.id, new Date(), audit);
    expect(revoked.map((r) => r.id)).toEqual([b.id]);
    expect(revoked[0]?.revokedAt).not.toBeNull();
    expect(await pats.revokeAllForPrincipal(u.id, new Date())).toEqual([]);
    expect(await verifyAuditChain(h.db.prisma)).toMatchObject({ ok: true });
  });

  it('9.1 SCIM tokens: create, find by hash, revoke', async () => {
    const repo = createScimTokenRepository(h.db.prisma);
    const admin = await seedUser('scimadmin@acme.com');
    const t = await repo.create(
      { name: 'okta', tokenSha256: sha('scim-1'), createdBy: admin.id },
      audit,
    );
    expect(await repo.findByHash(sha('scim-1'))).toEqual({
      id: t.id,
      expiresAt: null,
      revokedAt: null,
    });
    expect(await repo.findByHash(sha('nope'))).toBeNull();
    await expect(
      repo.create({ name: 'dup', tokenSha256: sha('scim-1'), createdBy: admin.id }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(await repo.list()).toHaveLength(1);
    await repo.revoke(t.id, new Date(), audit);
    expect((await repo.findByHash(sha('scim-1')))?.revokedAt).not.toBeNull();
    await expect(repo.revoke(t.id, new Date())).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('9.3 service accounts: account and client in one row, rotate, disable', async () => {
    const teams = createTeamRepository(h.db.prisma);
    const team = await teams.create({ slug: 'sa-team', displayName: 'SA' });
    const repo = createServiceAccountRepository(h.db.prisma);
    const account = {
      id: newId(),
      teamId: team.id,
      slug: 'deployer',
      displayName: 'Deployer',
      status: 'active' as const,
      oauthClientId: 'sa_deployer',
      createdAt: new Date(),
    };
    const client = {
      clientId: 'sa_deployer',
      serviceAccountId: account.id,
      authMethod: 'client_secret_basic' as const,
      secretSha256: sha('s1'),
      jwks: null,
    };
    await repo.create(account, client, audit);
    await expect(
      repo.create({ ...account, id: newId() }, { ...client, clientId: 'x' }),
    ).rejects.toMatchObject({
      httpStatus: 409,
    });
    const found = await repo.findByClientId('sa_deployer');
    expect(found?.account).toMatchObject({ slug: 'deployer', status: 'active' });
    expect(found?.client).toEqual(client);
    expect(await repo.findByClientId('missing')).toBeNull();
    expect((await repo.listByTeam(team.id)).map((a) => a.slug)).toEqual(['deployer']);
    await repo.saveClient(
      {
        ...client,
        authMethod: 'private_key_jwt',
        secretSha256: null,
        jwks: [{ kty: 'EC', kid: 'k' }],
      },
      audit,
    );
    expect((await repo.findByClientId('sa_deployer'))?.client).toMatchObject({
      authMethod: 'private_key_jwt',
      secretSha256: null,
      jwks: [{ kty: 'EC', kid: 'k' }],
    });
    await expect(repo.saveClient({ ...client, serviceAccountId: newId() })).rejects.toMatchObject({
      httpStatus: 404,
    });
    await repo.setStatus(account.id, 'disabled', audit);
    expect(await repo.findById(account.id)).toMatchObject({ status: 'disabled' });
    await expect(repo.setStatus(newId(), 'active')).rejects.toMatchObject({ httpStatus: 404 });
    expect(await repo.findById(newId())).toBeNull();
    await expect(
      h.db.prisma.serviceAccount.update({ where: { id: account.id }, data: { status: 'weird' } }),
    ).rejects.toThrow();
  });

  it('9.3 OAuth client policies upsert, list and delete', async () => {
    const repo = createOAuthClientPolicyRepository(h.db.prisma);
    const admin = await seedUser('policyadmin@acme.com');
    expect(await repo.get('c1')).toBeNull();
    await repo.upsert({ clientId: 'c1', preApproved: true, blocked: false }, admin.id, audit);
    await repo.upsert({ clientId: 'c1', preApproved: false, blocked: true }, admin.id, audit);
    await repo.upsert({ clientId: 'c0', preApproved: false, blocked: false }, admin.id);
    expect(await repo.get('c1')).toEqual({ clientId: 'c1', preApproved: false, blocked: true });
    expect((await repo.list()).map((p) => p.clientId)).toEqual(['c0', 'c1']);
    await repo.delete('c1', audit);
    await repo.delete('c1', audit);
    expect(await repo.get('c1')).toBeNull();
  });

  it('9.2 oidc models: upsert, find by uid and user code, consume, grant revocation, purge', async () => {
    const store = createOidcModelStore(h.db.prisma);
    const row = (id: string, extra: Partial<Parameters<typeof store.upsert>[0]> = {}) => ({
      id,
      type: 'AccessToken',
      payload: { sub: 'u', scope: 'mcp:use' },
      grantId: 'g1',
      userCode: null,
      uid: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      ...extra,
    });
    await store.upsert(row('t1'));
    await store.upsert(row('t1', { payload: { sub: 'v' } }));
    await store.upsert(row('t2', { type: 'Session', uid: 'uid-1', userCode: 'ABCD' }));
    await store.upsert(row('t3', { expiresAt: new Date(Date.now() - 1000), grantId: null }));
    expect((await store.find('AccessToken', 't1'))?.payload).toEqual({ sub: 'v' });
    expect(await store.find('AccessToken', 'missing')).toBeNull();
    expect(await store.findByUid('Session', 'uid-1')).toMatchObject({ id: 't2' });
    expect(await store.findByUid('Session', 'nope')).toBeNull();
    expect(await store.findByUserCode('Session', 'ABCD')).toMatchObject({ id: 't2' });
    expect(await store.findByUserCode('Session', 'ZZZZ')).toBeNull();
    const at = new Date();
    await store.consume('AccessToken', 't1', at);
    expect((await store.find('AccessToken', 't1'))?.consumedAt?.getTime()).toBe(at.getTime());
    expect(await store.purgeExpired(new Date())).toBe(1);
    await store.revokeByGrantId('g1');
    expect(await store.find('AccessToken', 't1')).toBeNull();
    expect(await store.find('Session', 't2')).toBeNull();
    await store.upsert(row('t4'));
    await store.destroy('AccessToken', 't4');
    expect(await store.find('AccessToken', 't4')).toBeNull();
  });

  it('9.1 IdP connections: CRUD with ETag, default claim map, tokens', async () => {
    const repo = createIdpConnectionRepository(h.db.prisma);
    expect(await repo.count()).toBe(0);
    const created = await repo.create(
      {
        name: 'Okta',
        issuer: 'https://acme.okta.com',
        discoveryUrl: 'https://acme.okta.com/.well-known/openid-configuration',
        clientId: 'bastion',
        clientSecretId: newId(),
        scopes: ['openid', 'email'],
        claimMap: { groups: 'roles' },
        emailDomains: ['acme.com'],
        storeRefreshToken: false,
        apiScope: null,
        enterpriseManagedAuth: false,
        enabled: true,
      },
      audit,
    );
    expect(created.claimMap).toEqual({ email: 'email', name: 'name', groups: 'roles', sub: 'sub' });
    expect(await repo.get(created.id)).toEqual(created);
    expect((await repo.list()).map((c) => c.id)).toEqual([created.id]);
    const etag = (await repo.getWithEtag(created.id))?.etag ?? '';
    const updated = await repo.update(
      created.id,
      { enabled: false, scopes: ['openid'], emailDomains: [], claimMap: { sub: 'oid' } },
      { ifMatch: etag, audit },
    );
    expect(updated).toMatchObject({ enabled: false, scopes: ['openid'] });
    expect(updated.claimMap.sub).toBe('oid');
    await expect(repo.update(created.id, { name: 'x' }, { ifMatch: etag })).rejects.toMatchObject({
      httpStatus: 412,
    });
    await expect(repo.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(await repo.getWithEtag(newId())).toBeNull();

    const user = await seedUser('idp-user@acme.com');
    const tokens = createIdpTokenStore(h.db.prisma);
    const row = {
      userId: user.id,
      idpConnectionId: created.id,
      secretId: newId(),
      expiresAt: null,
      updatedAt: new Date(),
    };
    await tokens.put(row);
    await tokens.put({ ...row, secretId: newId() });
    expect((await tokens.get(user.id, created.id))?.secretId).not.toBe(row.secretId);
    await tokens.delete(user.id, created.id);
    expect(await tokens.get(user.id, created.id)).toBeNull();

    await repo.delete(created.id, {
      ifMatch: etagOf(
        await h.db.prisma.idpConnection.findUniqueOrThrow({ where: { id: created.id } }),
      ),
      audit,
    });
    await expect(repo.delete(created.id, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('9.6 upstream clients and tokens', async () => {
    const clients = createUpstreamClientStore(h.db.prisma);
    await clients.put({
      issuer: 'https://as.example',
      registration: 'dcr',
      clientId: 'c',
      clientSecretId: null,
      metadata: { a: 1 },
    });
    await clients.put({
      issuer: 'https://as.example',
      registration: 'cimd',
      clientId: 'c2',
      clientSecretId: null,
      metadata: {},
    });
    expect(await clients.get('https://as.example')).toMatchObject({
      registration: 'cimd',
      clientId: 'c2',
    });
    await clients.delete('https://as.example');
    expect(await clients.get('https://as.example')).toBeNull();

    const user = await seedUser('upstream@acme.com');
    const other = await seedUser('upstream2@acme.com');
    const inst = await (async () => {
      const id = newId();
      await h.db.prisma.installation.create({
        data: {
          id,
          ownerType: 'user',
          ownerId: user.id,
          slug: 'x',
          toolPrefix: 'x',
          displayName: 'X',
          origin: 'manual',
          personalSpec: { type: 'remote' },
        },
      });
      return id;
    })();
    const store = createUpstreamTokenStore(h.db.prisma);
    const base = {
      principalType: 'user' as const,
      principalId: user.id,
      installationId: inst,
      issuer: 'https://as.example',
      secretId: newId(),
      scopes: ['a'],
      expiresAt: new Date(Date.now() + 1000),
      status: 'valid' as const,
      updatedAt: new Date(),
    };
    await store.put(base);
    await store.put({ ...base, scopes: ['a', 'b'] });
    await store.put({
      ...base,
      principalId: other.id,
      expiresAt: new Date(Date.now() + 10_000_000),
    });
    expect((await store.get(user.id, inst))?.scopes).toEqual(['a', 'b']);
    expect(await store.get(newId(), inst)).toBeNull();
    expect((await store.listByInstallation(inst)).length).toBe(2);
    expect((await store.listByPrincipal(user.id)).length).toBe(1);
    expect(
      (await store.listExpiringBefore(new Date(Date.now() + 60_000))).map((r) => r.principalId),
    ).toEqual([user.id]);
    await store.put({ ...base, status: 'reconnect_required' });
    expect(await store.listExpiringBefore(new Date(Date.now() + 60_000))).toEqual([]);
    await store.delete(user.id, inst);
    expect(await store.get(user.id, inst)).toBeNull();
  });

  describe('22.3 secrets and keys', () => {
    const write = (name: string, over: Record<string, unknown> = {}) => ({
      id: newId(),
      scope: 'org' as const,
      ownerId: null,
      name,
      version: 1,
      ciphertext: randomBytes(16),
      iv: randomBytes(12),
      authTag: randomBytes(16),
      wrappedDek: randomBytes(48),
      kekRef: 'kek-1',
      ...over,
    });

    it('stores envelope columns, replaces by key, never lists ciphertext', async () => {
      const repo = createSecretRepository(h.db.prisma, { audit });
      const w = write('api-key');
      const meta = await repo.put(w);
      expect(meta).toMatchObject({ id: w.id, name: 'api-key', version: 1 });
      expect(Object.keys(meta)).not.toContain('ciphertext');
      const replaced = await repo.put({ ...write('api-key'), version: 2 });
      expect(replaced.id).toBe(w.id);
      const got = await repo.get({ scope: 'org', ownerId: null, name: 'api-key' });
      expect(got?.version).toBe(2);
      expect(got?.ciphertext.length).toBe(16);
      expect((await repo.getById(w.id))?.name).toBe('api-key');
      expect(await repo.getById(newId())).toBeNull();
      expect(await repo.get({ scope: 'org', ownerId: null, name: 'zzz' })).toBeNull();
      const list = await repo.listMetadata({ scope: 'org', ownerId: null });
      expect(list.map((m) => m.name)).toEqual(['api-key']);
      expect(Object.keys(list[0] ?? {})).not.toContain('wrappedDek');
      const owner = newId();
      await repo.put(write('same-name', { scope: 'user', ownerId: owner }));
      await repo.put(write('same-name', { scope: 'user', ownerId: newId() }));
      expect(await repo.listMetadata({ scope: 'user', ownerId: owner })).toHaveLength(1);
      expect(await repo.delete({ scope: 'org', ownerId: null, name: 'api-key' })).toBe(true);
      expect(await repo.delete({ scope: 'org', ownerId: null, name: 'api-key' })).toBe(false);
      expect(await repo.deleteById(newId())).toBe(false);
    });

    it('two concurrent first writes of an ownerless key leave one row (partial unique index)', async () => {
      const repo = createSecretRepository(h.db.prisma);
      await Promise.all([repo.put(write('race')), repo.put(write('race'))]);
      expect(await h.db.prisma.secret.count({ where: { name: 'race' } })).toBe(1);
    });

    it('re-wraps DEKs in id order and changes only wrapped_dek and kek_ref', async () => {
      const repo = createSecretRepository(h.db.prisma);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const w = write(`rewrap-${i}`, { kekRef: 'old' });
        ids.push(w.id);
        await repo.put(w);
      }
      const first = await repo.listWrappedDeksNotUnder('new', 2);
      expect(first).toHaveLength(2);
      const next = await repo.listWrappedDeksNotUnder('new', 2, first[1]?.id);
      expect(next.length).toBeGreaterThanOrEqual(1);
      const before = await repo.getById(ids[0] ?? '');
      await repo.updateWrappedDek(ids[0] ?? '', Buffer.from('wrapped'), 'new');
      const after = await repo.getById(ids[0] ?? '');
      expect(after?.kekRef).toBe('new');
      expect(after?.wrappedDek.toString()).toBe('wrapped');
      expect(after?.ciphertext.equals(before?.ciphertext ?? Buffer.alloc(0))).toBe(true);
      expect(after?.version).toBe(before?.version);
    });

    /** A plaintext stand-in for `SecretVault` over the real repository. */
    const fakeVault = (): SecretCodec => {
      const repo = createSecretRepository(h.db.prisma);
      return {
        async put(key) {
          const existing = await repo.get(key);
          return repo.put({
            ...write(key.name, { scope: key.scope, ownerId: key.ownerId }),
            id: existing?.id ?? newId(),
            ciphertext: Buffer.from(key.plaintext),
            version: (existing?.version ?? 0) + 1,
          });
        },
        async reveal(key: SecretKey) {
          const rec = await repo.get(key);
          if (!rec) throw new Error('missing');
          return rec.ciphertext;
        },
        delete: (key) => repo.delete(key),
        list: (f) => repo.listMetadata(f) as Promise<SecretMetadata[]>,
      };
    };

    it('9.3 key store: signing keys round-trip with their private secret, state keys keep their windows', async () => {
      const store = createKeyStore(h.db.prisma, fakeVault());
      const now = Date.now();
      const meta = {
        kid: 'kid-1',
        purpose: 'as' as const,
        alg: 'ES256' as const,
        publicJwk: { kty: 'EC', kid: 'kid-1' },
        activeFrom: new Date(now - 1000),
        retireAfter: new Date(now + 100_000),
      };
      await store.addSigningKey(meta, { kty: 'EC', d: 'secret' });
      await store.addSigningKey(
        { ...meta, kid: 'kid-0', purpose: 'upstream-client', activeFrom: new Date(now - 5000) },
        { d: 'x' },
      );
      expect(await store.listSigningKeys('as')).toEqual([meta]);
      expect((await store.listSigningKeys('upstream-client')).map((k) => k.kid)).toEqual(['kid-0']);
      expect(await store.loadSigningPrivateKey('kid-1')).toEqual({ kty: 'EC', d: 'secret' });
      // A duplicate kid fails and does not leave a second secret behind.
      await expect(store.addSigningKey(meta, { d: 'again' })).rejects.toThrow();
      expect(await store.loadSigningPrivateKey('kid-1')).toEqual({ kty: 'EC', d: 'secret' });

      const key = randomBytes(32);
      await store.addStateKey({
        kid: 'st_1',
        key,
        activeFrom: new Date(now),
        retireAfter: new Date(now + 2000),
      });
      await store.addStateKey({
        kid: 'st_0',
        key: randomBytes(32),
        activeFrom: new Date(now - 9000),
        retireAfter: new Date(now + 1000),
      });
      const states = await store.listStateKeys();
      expect(states.map((s) => s.kid)).toEqual(['st_0', 'st_1']);
      expect(states[1]?.key.equals(key)).toBe(true);
      expect(states[1]?.retireAfter.getTime()).toBe(now + 2000);
      await store.deleteStateKeys(['st_0']);
      expect((await store.listStateKeys()).map((s) => s.kid)).toEqual(['st_1']);

      await store.deleteSigningKeys([]);
      await store.deleteSigningKeys(['kid-1', 'kid-0']);
      expect(await store.listSigningKeys('as')).toEqual([]);
      await expect(store.loadSigningPrivateKey('kid-1')).rejects.toThrow('missing');
    });
  });
});
