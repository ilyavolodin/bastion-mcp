import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

const RATE = {
  name: 'Burst',
  subject: 'user',
  kind: 'rate',
  params: { points: 100, perSeconds: 10, burst: 20 },
};

describe('14 limit rules', () => {
  it('14.1 creates rules with defaults and rejects invalid parameters', async () => {
    api = await buildTestApi();
    const ok = await api.call('admin', 'POST', '/limit-rules', { body: RATE });
    expect(ok.status).toBe(201);
    expect(rec(ok.body)).toMatchObject({
      metric: 'calls',
      action: 'reject',
      enabled: true,
      subjectMatch: 'each',
    });
    const bad = await api.call('admin', 'POST', '/limit-rules', {
      body: { ...RATE, params: { points: -1, perSeconds: 10, burst: 0 } },
    });
    expect(bad.status).toBe(400);
    const wrongKind = await api.call('admin', 'POST', '/limit-rules', {
      body: { ...RATE, kind: 'quota' },
    });
    expect(wrongKind.status).toBe(400);
  });

  it('14.1 PATCH validates the merged rule (422) and publishes the limits topic', async () => {
    api = await buildTestApi();
    const ok = await api.call('admin', 'PATCH', '/limit-rules/lr-1', {
      headers: { 'if-match': '*' },
      body: { params: { points: 5, period: 'week' } },
    });
    expect(ok.status).toBe(200);
    const bad = await api.call('admin', 'PATCH', '/limit-rules/lr-1', {
      headers: { 'if-match': '*' },
      body: { params: { points: 5, period: 'fortnight' } },
    });
    expect(bad.status).toBe(422);
    expect(rec(bad.body).code).toBe('invalid_rule');
    expect(
      (await api.call('admin', 'PATCH', '/limit-rules/zzz', { body: { enabled: false } })).status,
    ).toBe(404);
    expect(api.publisher.messages.some((m) => m.message === '{"topic":"limits"}')).toBe(true);
  });

  it('14.1 deletes with If-Match and audits', async () => {
    api = await buildTestApi();
    expect((await api.call('admin', 'DELETE', '/limit-rules/lr-2')).status).toBe(428);
    expect(
      (await api.call('admin', 'DELETE', '/limit-rules/lr-2', { headers: { 'if-match': '*' } }))
        .status,
    ).toBe(204);
    expect(api.uow.audits.at(-1)?.action).toBe('limit_rule.delete');
  });

  it('10.1 managers cannot write limits but auditors can read them', async () => {
    api = await buildTestApi();
    expect((await api.call('managerOwn', 'POST', '/limit-rules', { body: RATE })).status).toBe(403);
    expect((await api.call('auditor', 'GET', '/limit-rules')).status).toBe(200);
  });

  it('14.2 usage reads the counter of an explicit subject, the org counter, or listed subjects', async () => {
    api = await buildTestApi();
    const explicit = await api.call('admin', 'GET', '/limit-rules/lr-1/usage', {
      query: { subjectId: 'user-member-a' },
    });
    expect(rec(explicit.body).items).toEqual([
      expect.objectContaining({
        ruleId: 'lr-1',
        subjectId: 'user-member-a',
        limit: 1000,
        consumed: 7,
        remaining: 993,
      }),
    ]);
    const org = await api.call('auditor', 'GET', '/limit-rules/lr-2/usage');
    expect(rec(org.body).items).toEqual([
      expect.objectContaining({ subjectId: 'org', limit: 600 }),
    ]);
    const none = await api.call('admin', 'GET', '/limit-rules/lr-1/usage');
    expect(rec(none.body).items).toEqual([]);
    await api.store.update('limit_rules', 'lr-1', { subjectMatch: ['a', 'b'] });
    const listed = await api.call('admin', 'GET', '/limit-rules/lr-1/usage');
    expect((rec(listed.body).items as unknown[]).length).toBe(2);
    expect((await api.call('admin', 'GET', '/limit-rules/nope/usage')).status).toBe(404);
  });
});
