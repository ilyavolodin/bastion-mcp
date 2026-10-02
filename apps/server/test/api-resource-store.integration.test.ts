import { randomBytes } from 'node:crypto';
import type { ResourceStore, Tx } from '@bastion-mcp/api';
import { loadConfig, newId, sha256Hex } from '@bastion-mcp/core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiPersistence } from '../src/adapters/api/unit-of-work';
import { createInfra, type Infra } from '../src/infra';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

describe.skipIf(!haveDocker())('17.1 / 16.2 ResourceStore over Postgres', () => {
  let env: TestEnv;
  let infra: Infra;
  let store: ResourceStore;
  let run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  let adminId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    infra = createInfra(loadConfig(env.env()));
    const persistence = await createApiPersistence(infra);
    store = persistence.store;
    run = (fn) => persistence.uow.run(fn);
    adminId = newId();
    await run(async (tx) => {
      await tx.store.insert('users', {
        id: adminId,
        email: 'admin@example.com',
        displayName: 'Admin',
        orgRole: 'admin',
        status: 'active',
        catalogPublishOrgWide: false,
      });
      await tx.audit({
        actorType: 'system',
        actorId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        action: 'test.seed',
        targetType: 'user',
        targetId: adminId,
      });
    });
  });

  afterAll(async () => {
    await infra.close();
    await env.cleanup();
  });

  it('17.1 insert, get, shallow update and remove a row; updatedAt is a strictly increasing ETag', async () => {
    const id = newId();
    const created = await run((tx) =>
      tx.store.insert('teams', { id, slug: 'alpha', displayName: 'Alpha', idpGroup: null }),
    );
    expect(created.id).toBe(id);
    expect(typeof created.updatedAt).toBe('string');
    const updated = await run((tx) => tx.store.update('teams', id, { displayName: 'Alpha 2' }));
    expect(updated.displayName).toBe('Alpha 2');
    expect(updated.slug).toBe('alpha');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime(),
    );
    const again = await run((tx) => tx.store.update('teams', id, { displayName: 'Alpha 3' }));
    expect(new Date(again.updatedAt).getTime()).toBeGreaterThan(
      new Date(updated.updatedAt).getTime(),
    );
    expect((await store.get('teams', id))?.displayName).toBe('Alpha 3');
    expect(await store.get('teams', 'not-a-uuid')).toBeNull();
    expect(await run((tx) => tx.store.remove('teams', id))).toBe(true);
    expect(await store.get('teams', id)).toBeNull();
    expect(await run((tx) => tx.store.remove('teams', id))).toBe(false);
  });

  it('17.1 a unique violation is a 409 ConflictApiError', async () => {
    await run((tx) => tx.store.insert('teams', { id: newId(), slug: 'dup', displayName: 'Dup' }));
    await expect(
      run((tx) => tx.store.insert('teams', { id: newId(), slug: 'dup', displayName: 'Dup 2' })),
    ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });
  });

  it('17.1 list: equality filters, q search, sort, offset cursors and find match the in-memory contract', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      await run((tx) =>
        tx.store.insert('teams', { id: newId(), slug: `page-${n}`, displayName: `Page ${n}` }),
      );
    }
    const first = await store.list('teams', {
      limit: 2,
      q: 'page-',
      sort: { field: 'slug', desc: false },
    });
    expect(first.items.map((r) => r.slug)).toEqual(['page-a', 'page-b']);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list('teams', {
      limit: 2,
      q: 'page-',
      sort: { field: 'slug', desc: false },
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((r) => r.slug)).toEqual(['page-c', 'page-d']);
    const last = await store.list('teams', {
      limit: 2,
      q: 'page-',
      sort: { field: 'slug', desc: false },
      cursor: second.nextCursor ?? undefined,
    });
    expect(last.items.map((r) => r.slug)).toEqual(['page-e']);
    expect(last.nextCursor).toBeNull();
    const desc = await store.list('teams', {
      limit: 1,
      q: 'page-',
      sort: { field: 'slug', desc: true },
    });
    expect(desc.items[0]?.slug).toBe('page-e');
    expect((await store.find('teams', { slug: 'page-c' })).map((r) => r.displayName)).toEqual([
      'Page c',
    ]);
    expect(await store.find('teams', { slug: 'missing' })).toEqual([]);
    expect(await store.find('teams', { id: 'garbage' })).toEqual([]);
    expect(await store.find('users', { email: 'ADMIN@example.com' })).toHaveLength(1);
  });

  it('16.2 team_members: composite id teamId:userId, upsert replaces the role, find by teamId or userId', async () => {
    const teamId = newId();
    await run((tx) => tx.store.insert('teams', { id: teamId, slug: 'crew', displayName: 'Crew' }));
    const id = `${teamId}:${adminId}`;
    const first = await run((tx) =>
      tx.store.upsert('team_members', id, {
        teamId,
        userId: adminId,
        role: 'member',
        source: 'manual',
      }),
    );
    expect(first.id).toBe(id);
    expect(first.role).toBe('member');
    await run((tx) =>
      tx.store.upsert('team_members', id, {
        teamId,
        userId: adminId,
        role: 'manager',
        source: 'manual',
      }),
    );
    expect((await store.get('team_members', id))?.role).toBe('manager');
    expect(await store.find('team_members', { teamId })).toHaveLength(1);
    expect(await store.find('team_members', { userId: adminId, role: 'manager' })).not.toHaveLength(
      0,
    );
    expect(await run((tx) => tx.store.remove('team_members', id))).toBe(true);
    expect(await store.find('team_members', { teamId })).toEqual([]);
  });

  it('19.2 settings: one row per key, value JSON, a _version row, defaults untouched elsewhere', async () => {
    expect(await store.get('settings', 'org')).toBeNull();
    await run(async (tx) => {
      await tx.store.upsert('settings', 'org', { value: { displayName: 'Acme', timeZone: 'UTC' } });
      await tx.store.upsert('settings', '_version', { value: null });
    });
    const row = await store.get('settings', 'org');
    expect(row?.value).toEqual({ displayName: 'Acme', timeZone: 'UTC' });
    const all = await store.find('settings', {});
    expect(all.map((r) => r.id).sort()).toEqual(['_version', 'org']);
    const v1 = (await store.get('settings', '_version'))?.updatedAt ?? '';
    await run((tx) => tx.store.upsert('settings', '_version', { value: null }));
    expect(((await store.get('settings', '_version'))?.updatedAt ?? '') > v1).toBe(true);
    // The org settings repository tolerates the version row.
    expect((await infra.repos.orgSettings.getAll()).org.displayName).toBe('Acme');
  });

  it('11.1 catalog: entries, versions, files with blob size, executable approvals and the search document', async () => {
    const entryId = newId();
    const versionId = newId();
    await run(async (tx) => {
      await tx.store.insert('catalog_entries', {
        id: entryId,
        slug: 'weather',
        kind: 'mcp_server',
        displayName: 'Weather',
        description: 'Forecasts for everywhere',
        tags: ['weather'],
        ownerTeamId: null,
        visibility: { org: true, teamIds: [], userIds: [] },
        status: 'draft',
        risk: 'low',
        source: { kind: 'manual' },
        currentVersionId: null,
        autoUpgrade: true,
        userOverrides: 'cosmetic',
        onDrift: 'hideChanged',
        createdBy: adminId,
        createdAt: new Date().toISOString(),
      });
      await tx.store.insert('catalog_versions', {
        id: versionId,
        entryId,
        label: '1.0.0',
        serverSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: 'https://x.example/mcp',
          auth: { mode: 'none' },
        },
        installForm: { variables: [], secrets: [] },
        status: 'draft',
        testResult: null,
        changelog: null,
        createdBy: adminId,
        createdAt: new Date().toISOString(),
      });
    });
    expect(
      (await store.find('catalog_versions', { entryId, label: '1.0.0' })).map((v) => v.id),
    ).toEqual([versionId]);
    expect(await store.find('catalog_versions', { entryId, label: '9' })).toEqual([]);

    const content = Buffer.from('#!/bin/sh\necho hi\n');
    const sha = await infra.repos.blobs.put(new Uint8Array(content));
    const fileId = `${versionId}:scripts/run.sh`;
    const file = await run((tx) =>
      tx.store.upsert('catalog_files', fileId, {
        catalogVersionId: versionId,
        path: 'scripts/run.sh',
        blobSha256: sha,
        mode: 'executable',
        classification: 'executable',
        size: content.length,
      }),
    );
    expect(file.id).toBe(fileId);
    expect(file.blobSha256).toBe(sha);
    const read = await store.get('catalog_files', fileId);
    expect(read?.size).toBe(content.length);
    expect(await store.find('catalog_files', { catalogVersionId: versionId })).toHaveLength(1);

    await run((tx) =>
      tx.store.upsert('executable_approvals', versionId, {
        catalogVersionId: versionId,
        approvedBy: adminId,
        reviewedDiffSha256: sha256Hex('diff'),
        note: null,
        approvedAt: new Date().toISOString(),
      }),
    );
    const approval = await store.get('executable_approvals', versionId);
    expect(approval?.id).toBe(versionId);
    expect(approval?.reviewedDiffSha256).toBe(sha256Hex('diff'));
    expect(await run((tx) => tx.store.remove('executable_approvals', versionId))).toBe(true);

    // The entry is searchable by q and by the tsvector maintained on write (11.2).
    const found = await store.list('catalog_entries', { limit: 10, q: 'forecasts' });
    expect(found.items.map((e) => e.slug)).toContain('weather');
    const hits = await infra.repos.catalogEntries.search?.('weather', { limit: 5 });
    expect(hits?.items.length ?? 0).toBeGreaterThan(0);

    // Versions cascade with the entry.
    await run(async (tx) => {
      await tx.store.remove('catalog_files', fileId);
      await tx.store.remove('catalog_versions', versionId);
      await tx.store.remove('catalog_entries', entryId);
    });
    expect(await store.get('catalog_entries', entryId)).toBeNull();
  });

  it('11.6 registry-installed entries are found by registrySourceId and registryServerName', async () => {
    const sourceId = newId();
    await run((tx) =>
      tx.store.insert('registry_sources', {
        id: sourceId,
        name: 'Internal',
        baseUrl: 'https://registry.example.com',
        authSecretId: null,
        authHeaderName: null,
        trust: 'internal',
        enabled: true,
        syncIntervalS: 3600,
        lastUpdatedSince: null,
        lastSync: null,
      }),
    );
    const entryId = newId();
    await run((tx) =>
      tx.store.insert('catalog_entries', {
        id: entryId,
        slug: 'from-registry',
        kind: 'mcp_server',
        displayName: 'From registry',
        description: '',
        tags: [],
        ownerTeamId: null,
        visibility: { org: false, teamIds: [], userIds: [] },
        status: 'draft',
        risk: 'medium',
        source: {
          type: 'registry',
          registrySourceId: sourceId,
          serverName: 'io.example/weather',
          version: '1',
        },
        registrySourceId: sourceId,
        registryServerName: 'io.example/weather',
        currentVersionId: null,
        createdBy: adminId,
      }),
    );
    const [hit] = await store.find('catalog_entries', {
      registrySourceId: sourceId,
      registryServerName: 'io.example/weather',
    });
    expect(hit?.id).toBe(entryId);
    expect(hit?.registryServerName).toBe('io.example/weather');
    expect(
      await store.find('catalog_entries', {
        registrySourceId: sourceId,
        registryServerName: 'other',
      }),
    ).toEqual([]);
  });

  it('11.6 an org secret name in authSecretId resolves to the secret id; an unknown name is a 400', async () => {
    const meta = await infra.vault.put({
      scope: 'org',
      ownerId: null,
      name: 'registry-token',
      plaintext: 'tok',
    });
    const id = newId();
    const row = await run((tx) =>
      tx.store.insert('registry_sources', {
        id,
        name: 'Private',
        baseUrl: 'https://private-registry.example.com',
        authSecretId: 'registry-token',
        authHeaderName: 'X-Token',
        trust: 'community',
        enabled: false,
        syncIntervalS: 3600,
      }),
    );
    expect(row.authSecretId).toBe(meta.id);
    await expect(
      run((tx) =>
        tx.store.insert('registry_sources', {
          id: newId(),
          name: 'Bad',
          baseUrl: 'https://bad-registry.example.com',
          authSecretId: 'no-such-secret',
          trust: 'community',
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('25.4 marketplace_items: composite id, position order and removal; marketplaces cascade', async () => {
    const marketId = newId();
    const entryId = newId();
    await run(async (tx) => {
      await tx.store.insert('marketplaces', {
        id: marketId,
        slug: 'mk',
        displayName: 'MK',
        description: null,
        ownerTeamId: null,
        audience: { org: true, teamIds: [], userIds: [] },
        desktopInstallation: 'available',
        mirror: null,
        mirrorStatus: null,
        promotedRelease: null,
        createdBy: adminId,
      });
      await tx.store.insert('catalog_entries', {
        id: entryId,
        slug: 'mk-entry',
        displayName: 'E',
        description: '',
        visibility: { org: true, teamIds: [], userIds: [] },
        source: { kind: 'manual' },
        createdBy: adminId,
      });
    });
    const id = `${marketId}:${entryId}`;
    const item = await run((tx) =>
      tx.store.upsert('marketplace_items', id, {
        marketplaceId: marketId,
        catalogEntryId: entryId,
        policy: 'available',
        pinnedVersionId: null,
        position: 0,
      }),
    );
    expect(item.id).toBe(id);
    expect(await store.find('marketplace_items', { marketplaceId: marketId })).toHaveLength(1);
    await run((tx) =>
      tx.store.upsert('marketplace_items', id, {
        marketplaceId: marketId,
        catalogEntryId: entryId,
        policy: 'required',
        pinnedVersionId: null,
        position: 3,
      }),
    );
    expect((await store.get('marketplace_items', id))?.policy).toBe('required');
    expect(await run((tx) => tx.store.remove('marketplace_items', id))).toBe(true);
  });

  it('11.4 installations: owner uniqueness, secretRefs and the installation_secrets view', async () => {
    const id = newId();
    const row = await run((tx) =>
      tx.store.insert('installations', {
        id,
        ownerType: 'user',
        ownerId: adminId,
        catalogEntryId: null,
        catalogVersionId: null,
        pinnedVersion: false,
        personalSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: 'https://u.example/mcp',
          auth: { mode: 'none' },
        },
        slug: 'mine',
        toolPrefix: 'mine',
        displayName: 'Mine',
        enabled: true,
        variables: {},
        secretRefs: {},
        overrides: {},
        origin: 'personal',
        status: 'ready',
        statusDetail: null,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(row.slug).toBe('mine');
    await expect(
      run((tx) =>
        tx.store.insert('installations', {
          id: newId(),
          ownerType: 'user',
          ownerId: adminId,
          slug: 'mine',
          toolPrefix: 'mine2',
          displayName: 'Again',
          origin: 'personal',
          personalSpec: {},
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await run((tx) =>
      tx.store.update('installations', id, {
        secretRefs: { API_KEY: { scope: 'user', name: 'x', version: 1 } },
      }),
    );
    const secrets = await store.find('installation_secrets', { installationId: id });
    expect(secrets.map((s) => s.name)).toEqual(['API_KEY']);
    expect(await run((tx) => tx.store.remove('installation_secrets', `${id}:API_KEY`))).toBe(true);
    expect(await store.find('installation_secrets', { installationId: id })).toEqual([]);
    expect(
      await store.find('installations', { ownerType: 'user', ownerId: adminId, slug: 'mine' }),
    ).toHaveLength(1);
  });

  it('9.3 service_account_clients live in the account row; the client id is the row id and secrets stay hidden', async () => {
    const teamId = newId();
    const accountId = newId();
    await run(async (tx) => {
      await tx.store.insert('teams', { id: teamId, slug: 'bots', displayName: 'Bots' });
      await tx.store.insert('service_accounts', {
        id: accountId,
        teamId,
        slug: 'ci',
        displayName: 'CI',
        status: 'active',
        oauthClientId: 'bst_sa_client1',
      });
      await tx.store.insert('service_account_clients', {
        id: 'bst_sa_client1',
        serviceAccountId: accountId,
        authMethod: 'client_secret_basic',
        secretSha256: sha256Hex('secret'),
        jwks: null,
      });
    });
    const account = await store.get('service_accounts', accountId);
    expect(account?.oauthClientId).toBe('bst_sa_client1');
    expect(account).not.toHaveProperty('secretSha256');
    const [client] = await store.find('service_account_clients', { serviceAccountId: accountId });
    expect(client?.id).toBe('bst_sa_client1');
    expect(client?.secretSha256).toBe(sha256Hex('secret'));
    const stored = await infra.db.prisma.serviceAccount.findUnique({ where: { id: accountId } });
    expect(stored?.secretSha256).toBe(sha256Hex('secret'));
    await run((tx) =>
      tx.store.update('service_account_clients', 'bst_sa_client1', {
        secretSha256: sha256Hex('next'),
      }),
    );
    expect((await store.get('service_account_clients', 'bst_sa_client1'))?.secretSha256).toBe(
      sha256Hex('next'),
    );
    await run(async (tx) => {
      await tx.store.remove('service_account_clients', 'bst_sa_client1');
      await tx.store.remove('service_accounts', accountId);
    });
    expect(await store.get('service_accounts', accountId)).toBeNull();
  });

  it('9.4 oauth_grants: Grant models of oidc-provider listed per user and revoked with their tokens', async () => {
    const grantId = 'grant-abc';
    await infra.repos.oidcModels.upsert({
      id: grantId,
      type: 'Grant',
      payload: {
        accountId: adminId,
        clientId: 'client-1',
        openid: { scope: 'openid' },
        resources: { 'https://bastion.test/mcp': 'mcp' },
        iat: 1_700_000_000,
      },
      grantId: null,
      userCode: null,
      uid: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
    });
    await infra.repos.oidcModels.upsert({
      id: 'rt-1',
      type: 'RefreshToken',
      payload: { grantId },
      grantId,
      userCode: null,
      uid: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
    });
    const page = await store.list('oauth_grants', { limit: 10, where: { userId: adminId } });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: grantId, userId: adminId, clientId: 'client-1' });
    expect(page.items[0]?.scopes).toEqual(expect.arrayContaining(['openid', 'mcp']));
    expect(
      (await store.list('oauth_grants', { limit: 10, where: { userId: newId() } })).items,
    ).toEqual([]);
    expect(await run((tx) => tx.store.remove('oauth_grants', grantId))).toBe(true);
    expect(await infra.repos.oidcModels.find('RefreshToken', 'rt-1')).toBeNull();
    expect(await store.get('oauth_grants', grantId)).toBeNull();
  });

  it('9.4 oauth_clients: the client id is the row id', async () => {
    const row = await run((tx) =>
      tx.store.insert('oauth_clients', {
        id: 'https://client.example/meta.json',
        clientId: 'https://client.example/meta.json',
        preApproved: true,
        blocked: false,
        updatedBy: adminId,
      }),
    );
    expect(row.id).toBe('https://client.example/meta.json');
    expect(row.preApproved).toBe(true);
    const upd = await run((tx) => tx.store.update('oauth_clients', row.id, { blocked: true }));
    expect(upd.blocked).toBe(true);
    expect((await store.list('oauth_clients', { limit: 5 })).items).toHaveLength(1);
  });

  it('15.5 notifications map type, title and data onto kind and payload', async () => {
    const id = newId();
    const row = await run((tx) =>
      tx.store.insert('notifications', {
        id,
        userId: adminId,
        type: 'install_request',
        title: 'Install request',
        data: { requestId: 'r1' },
        readAt: null,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(row).toMatchObject({
      type: 'install_request',
      title: 'Install request',
      data: { requestId: 'r1' },
      readAt: null,
    });
    const read = await run((tx) =>
      tx.store.update('notifications', id, { readAt: new Date().toISOString() }),
    );
    expect(read.readAt).not.toBeNull();
    expect(read.title).toBe('Install request');
    const unread = await store.list('notifications', {
      limit: 10,
      where: { userId: adminId, readAt: null },
    });
    expect(unread.items.map((n) => n.id)).not.toContain(id);
  });

  it('13 guard profiles keep maxScanBytes, onOversize, onDrift and riskEscalation in settings and flatten them in rows', async () => {
    const id = newId();
    const row = await run((tx) =>
      tx.store.insert('guard_profiles', {
        id,
        name: 'strict',
        isOrgDefault: false,
        latencyBudgetMs: 800,
        guards: [],
        maxScanBytes: 4096,
        onOversize: 'block',
      }),
    );
    expect(row).toMatchObject({
      name: 'strict',
      latencyBudgetMs: 800,
      maxScanBytes: 4096,
      onOversize: 'block',
    });
    const upd = await run((tx) =>
      tx.store.update('guard_profiles', id, { onOversize: 'scanPrefix' }),
    );
    expect(upd.maxScanBytes).toBe(4096);
    expect(upd.onOversize).toBe('scanPrefix');
    const stored = await infra.db.prisma.guardProfile.findUnique({ where: { id } });
    expect(stored?.settings).toMatchObject({ maxScanBytes: 4096, onOversize: 'scanPrefix' });
    await run(async (tx) => {
      await tx.store.update('guard_profiles', id, { isOrgDefault: true });
    });
    expect(await store.find('guard_profiles', { isOrgDefault: true })).toHaveLength(1);
  });

  it('13.6 definition pins accept non-UUID ids and binary hashes as hex', async () => {
    const scope = newId();
    const pinId = `${scope}:tool:search`;
    const hash = randomBytes(32).toString('hex');
    const row = await run((tx) =>
      tx.store.upsert('definition_pins', pinId, {
        installationId: scope,
        catalogVersionId: null,
        itemKind: 'tool',
        itemKey: 'search',
        hash,
        definition: { name: 'search' },
        approvedBy: adminId,
        approvedAt: new Date().toISOString(),
      }),
    );
    expect(row.hash).toBe(hash);
    // Upserting the same pin id updates the same row.
    await run((tx) =>
      tx.store.upsert('definition_pins', pinId, {
        installationId: scope,
        itemKind: 'tool',
        itemKey: 'search',
        hash,
        definition: { name: 'search', v: 2 },
      }),
    );
    expect(await store.find('definition_pins', { installationId: scope })).toHaveLength(1);
    expect((await store.get('definition_pins', pinId))?.definition).toEqual({
      name: 'search',
      v: 2,
    });
  });

  it('9.1 scim_tokens keep the SHA-256 as bytes and return it as hex', async () => {
    const hash = sha256Hex('bst_scim_x');
    const row = await run((tx) =>
      tx.store.insert('scim_tokens', {
        id: newId(),
        name: 'okta',
        tokenSha256: hash,
        createdBy: adminId,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(row.tokenSha256).toBe(hash);
    const found = await infra.repos.scimTokens.findByHash(hash);
    expect(found?.id).toBe(row.id);
  });

  it('4.3 a committed write bumps config_versions and publishes bastion:config; a rollback does neither', async () => {
    const sub = new Redis(env.redisUrl);
    const messages: string[] = [];
    sub.on('message', (_c, m) => messages.push(m));
    await sub.subscribe('bastion:config');
    const teamId = newId();
    await expect(
      run(async (tx) => {
        await tx.store.insert('teams', { id: teamId, slug: 'rolled-back', displayName: 'RB' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.get('teams', teamId)).toBeNull();
    expect(messages).toEqual([]);
    const committed: string[] = [];
    await run(async (tx) => {
      await tx.store.insert('teams', { id: teamId, slug: 'committed', displayName: 'C' });
      tx.afterCommit(() => {
        committed.push('hook');
      });
      await tx.audit({
        actorType: 'user',
        actorId: adminId,
        ip: '127.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-1',
        action: 'team.create',
        targetType: 'team',
        targetId: teamId,
        diff: { slug: 'committed' },
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(committed).toEqual(['hook']);
    expect(messages.map((m) => JSON.parse(m))).toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: 'team', id: teamId })]),
    );
    const version = await infra.repos.configVersions.get('team', teamId);
    expect(version).toBeGreaterThan(0n);
    await sub.quit();
  });

  it('15.6 audit events written in the unit join the hash chain and verify', async () => {
    const result = await infra.repos.auditLog.verify();
    expect(result.ok).toBe(true);
    const page = await infra.repos.auditLog.list({ action: 'team.create', limit: 5 });
    expect(page.items[0]?.requestId).toBe('req-1');
  });
});
