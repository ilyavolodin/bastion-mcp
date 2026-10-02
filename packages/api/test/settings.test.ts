import { afterEach, describe, expect, it } from 'vitest';
import { findInlineSecrets } from '../src/services/settings';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const settingsOf = (v: unknown): Record<string, unknown> => rec(rec(v).settings);

describe('19.2 settings', () => {
  it('19.2 returns defaults merged with stored keys and the settings version as ETag', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/settings');
    expect(res.status).toBe(200);
    expect(rec(settingsOf(res.body).org).displayName).toBe('Bastion');
    expect(res.headers.etag).toBeDefined();
    expect((await api.call('auditor', 'GET', '/settings')).status).toBe(200);
    expect((await api.call('member', 'GET', '/settings')).status).toBe(403);
  });

  it('19.2 PATCH replaces the given keys, bumps the version and publishes bastion:config', async () => {
    api = await buildTestApi();
    const before = await api.call('admin', 'GET', '/settings');
    const res = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': String(before.headers.etag) },
      body: {
        personalInstalls: 'off',
        logs: { retentionDays: 7, capturePreviews: true, managerVisibility: false },
      },
    });
    expect(res.status).toBe(200);
    expect(settingsOf(res.body).personalInstalls).toBe('off');
    expect(rec(settingsOf(res.body).logs).retentionDays).toBe(7);
    expect(rec(settingsOf(res.body).org).displayName).toBe('Bastion');
    expect(res.headers.etag).not.toBe(before.headers.etag);
    expect(api.publisher.messages.at(-1)).toEqual({
      channel: 'bastion:config',
      message: '{"topic":"settings"}',
    });
    const audit = api.uow.audits.at(-1);
    expect(audit).toMatchObject({ action: 'settings.update', targetType: 'settings' });
    const reread = await api.call('admin', 'GET', '/settings');
    expect(settingsOf(reread.body).personalInstalls).toBe('off');
  });

  it('17.1 PATCH needs If-Match even for the first write and refuses a stale one', async () => {
    api = await buildTestApi();
    const missing = await api.call('admin', 'PATCH', '/settings', {
      body: { personalInstalls: 'all' },
    });
    expect(missing.status).toBe(428);
    const first = await api.call('admin', 'GET', '/settings');
    await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': String(first.headers.etag) },
      body: { personalInstalls: 'all' },
    });
    const stale = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': String(first.headers.etag) },
      body: { personalInstalls: 'off' },
    });
    expect(stale.status).toBe(412);
  });

  it('19.2 validates each key and rejects unknown keys and empty patches', async () => {
    api = await buildTestApi();
    const headers = { 'if-match': '*' };
    expect(
      (
        await api.call('admin', 'PATCH', '/settings', {
          headers,
          body: { personalInstalls: 'sometimes' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.call('admin', 'PATCH', '/settings', {
          headers,
          body: { tokens: { accessTtlSeconds: -1 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.call('admin', 'PATCH', '/settings', { headers, body: { nonsense: true } })).status,
    ).toBe(400);
    expect((await api.call('admin', 'PATCH', '/settings', { headers, body: {} })).status).toBe(400);
  });

  it('22.3 refuses secrets stored inline in settings', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': '*' },
      body: { modelGuards: { jev: { apiKey: 'sk-live-123' }, llmJudge: null, classifier: null } },
    });
    expect(res.status).toBe(400);
    expect(rec(res.body).code).toBe('validation_failed');
    expect(JSON.stringify(res.body)).not.toContain('sk-live-123');
    const webhook = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': '*' },
      body: { audit: { retentionDays: 30, webhookUrl: 'https://user:pass@example.com/hook' } },
    });
    expect(webhook.status).toBe(400);
    const ref = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': '*' },
      body: {
        modelGuards: { jev: { apiKeySecretId: 'secret-1' }, llmJudge: null, classifier: null },
      },
    });
    expect(ref.status).toBe(200);
  });

  it('13 the default guard profile must exist', async () => {
    api = await buildTestApi();
    const missing = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': '*' },
      body: { guards: { orgDefaultProfileId: '8a1f1c50-0c7a-4f0a-8f3a-5d6b8b0f2a11' } },
    });
    expect(missing.status).toBe(400);
    await api.store.seed('guard_profiles', {
      id: '8a1f1c50-0c7a-4f0a-8f3a-5d6b8b0f2a11',
      name: 'default',
    });
    const ok = await api.call('admin', 'PATCH', '/settings', {
      headers: { 'if-match': '*' },
      body: { guards: { orgDefaultProfileId: '8a1f1c50-0c7a-4f0a-8f3a-5d6b8b0f2a11' } },
    });
    expect(ok.status).toBe(200);
  });

  it('10.1 only admins change settings', async () => {
    api = await buildTestApi();
    for (const actor of ['managerOwn', 'auditor', 'member', 'service'] as const) {
      const res = await api.call(actor, 'PATCH', '/settings', {
        headers: { 'if-match': '*' },
        body: { personalInstalls: 'off' },
      });
      expect(res.status).toBe(403);
    }
  });

  it('22.3 findInlineSecrets flags secret-looking strings but not references or numbers', () => {
    expect(findInlineSecrets({ a: { token: 'abc' } })).toEqual(['/a/token']);
    expect(findInlineSecrets({ list: [{ password: 'x' }] })).toEqual(['/list/0/password']);
    expect(
      findInlineSecrets({ apiKeyRef: 'r', tokenId: 'i', tokens: { accessTtlSeconds: 900 } }),
    ).toEqual([]);
    expect(findInlineSecrets({ url: 'https://u:p@h.example' })).toEqual([
      '/url (URL with credentials)',
    ]);
    expect(findInlineSecrets({ url: 'https://h.example', n: 1, b: null })).toEqual([]);
  });
});

describe('15.7 system status and rotation', () => {
  it('15.7 aggregates replicas, leases, queues, driver, registry sync and KMS', async () => {
    api = await buildTestApi();
    const res = await api.call('auditor', 'GET', '/system/status');
    expect(res.status).toBe(200);
    expect(rec(res.body)).toMatchObject({
      configVersion: 'cfg-1',
      driver: { name: 'docker', healthy: true },
      kms: { provider: 'local' },
    });
    expect((await api.call('managerOwn', 'GET', '/system/status')).status).toBe(200);
    expect((await api.call('member', 'GET', '/system/status')).status).toBe(403);
  });

  it('22.3 rotates the KMS key with an audit event', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/system/kms/rotate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kekRef: 'kek-2', rewrapped: 3 });
    expect(api.uow.audits.at(-1)).toMatchObject({
      action: 'system.kms.rotate',
      targetType: 'system',
    });
    expect((await api.call('managerOwn', 'POST', '/system/kms/rotate')).status).toBe(403);
  });

  it('9.3 rotates signing keys and tells workers to reload them', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/system/signing-keys/rotate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kids: ['kid-2'] });
    expect(api.publisher.messages.at(-1)).toEqual({
      channel: 'bastion:config',
      message: '{"topic":"signing_keys"}',
    });
    expect(api.uow.audits.at(-1)?.action).toBe('system.signing_keys.rotate');
    expect((await api.call('auditor', 'POST', '/system/signing-keys/rotate')).status).toBe(403);
  });
});
