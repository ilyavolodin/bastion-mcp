import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

const RULE = {
  name: 'Block deletes',
  effect: 'forbid',
  who: { role: 'member' },
  what: { toolName: 'delete_*' },
};

const SIM_TEST = {
  name: 'members may still see tools',
  request: {
    principal: { kind: 'user', id: 'u1', role: 'member', teams: [] },
    action: 'seeTool',
    resource: {
      type: 'Tool',
      installation: { id: 'i1', catalogEntryId: 'c1' },
      name: 'search',
    },
  },
  expect: 'deny',
};

describe('10.3 policy rules', () => {
  it('10.3 lists, creates, patches and deletes rules with audit and config publication', async () => {
    api = await buildTestApi();
    const list = await api.call('admin', 'GET', '/policy-rules');
    expect(rec(list.body).items).toHaveLength(1);
    const created = await api.call('admin', 'POST', '/policy-rules', { body: RULE });
    expect(created.status).toBe(201);
    expect(rec(created.body)).toMatchObject({ enabled: true, priority: 100 });
    const id = String(rec(created.body).id);
    const patched = await api.call('admin', 'PATCH', `/policy-rules/${id}`, {
      headers: { 'if-match': String(created.headers.etag) },
      body: { enabled: false },
    });
    expect(patched.status).toBe(200);
    expect(rec(patched.body).enabled).toBe(false);
    const del = await api.call('admin', 'DELETE', `/policy-rules/${id}`, {
      headers: { 'if-match': String(patched.headers.etag) },
    });
    expect(del.status).toBe(204);
    expect(api.uow.audits.map((a) => a.action)).toEqual([
      'policy_rule.create',
      'policy_rule.update',
      'policy_rule.delete',
    ]);
    expect(api.publisher.messages.every((m) => m.message === '{"topic":"policy"}')).toBe(true);
  });

  it('10.3 rejects rules that do not parse or compile with a 422', async () => {
    api = await buildTestApi();
    const bad = await api.call('admin', 'POST', '/policy-rules', {
      body: { ...RULE, when: { hours: { from: 5, to: 5 } } },
    });
    expect(bad.status).toBe(422);
    expect(rec(bad.body).code).toBe('invalid_rule');
    const patch = await api.call('admin', 'PATCH', '/policy-rules/rule-1', {
      headers: { 'if-match': '*' },
      body: { who: { users: [], role: 'bogus' } },
    });
    expect([400, 422]).toContain(patch.status);
    expect(
      (await api.call('admin', 'PATCH', '/policy-rules/nope', { body: { enabled: true } })).status,
    ).toBe(404);
  });

  it('10.1 only admins write rules; auditors and managers may view them', async () => {
    api = await buildTestApi();
    expect((await api.call('managerOwn', 'POST', '/policy-rules', { body: RULE })).status).toBe(
      403,
    );
    expect((await api.call('auditor', 'GET', '/policy-rules')).status).toBe(200);
    expect((await api.call('member', 'GET', '/policy-rules')).status).toBe(403);
  });
});

describe('10.3 custom policies', () => {
  const CEDAR =
    'forbid (principal, action == Bastion::Action::"callTool", resource) when { false };';

  it('10.3 validates before saving: invalid Cedar is a 422 with the report', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/custom-policies', {
      body: { name: 'Broken', cedar: 'this is not cedar', tests: [SIM_TEST] },
    });
    expect(res.status).toBe(422);
    expect(rec(res.body).code).toBe('invalid_policy');
    expect((rec(res.body).errors as unknown[]).length).toBeGreaterThan(0);
    expect(await api.store.find('custom_policies', { name: 'Broken' })).toHaveLength(0);
  });

  it('10.3 requires at least one test case', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/custom-policies', {
      body: { name: 'NoTests', cedar: CEDAR, tests: [] },
    });
    expect(res.status).toBe(400);
  });

  it('10.3 POST /policies/validate reports without saving anything', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/policies/validate', {
      body: { cedar: 'this is not cedar', tests: [] },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).ok).toBe(false);
    expect((rec(res.body).errors as string[]).length).toBeGreaterThan(0);
    expect(api.uow.audits).toHaveLength(0);
  });

  it('10.3 a valid policy with a passing test is stored, patched and deleted', async () => {
    api = await buildTestApi();
    const validate = await api.call('admin', 'POST', '/policies/validate', {
      body: { cedar: CEDAR, tests: [{ ...SIM_TEST, expect: 'deny' }] },
    });
    expect(rec(validate.body).errors).toEqual([]);
    expect(rec(validate.body).ok).toBe(true);
    const created = await api.call('admin', 'POST', '/custom-policies', {
      body: { name: 'Fine', cedar: CEDAR, tests: [{ ...SIM_TEST, expect: 'deny' }] },
    });
    expect(created.status).toBe(201);
    const id = String(rec(created.body).id);
    const patched = await api.call('admin', 'PATCH', `/custom-policies/${id}`, {
      headers: { 'if-match': String(created.headers.etag) },
      body: { enabled: false },
    });
    expect(patched.status).toBe(200);
    const bad = await api.call('admin', 'PATCH', `/custom-policies/${id}`, {
      headers: { 'if-match': '*' },
      body: { cedar: 'nonsense' },
    });
    expect(bad.status).toBe(422);
    const del = await api.call('admin', 'DELETE', `/custom-policies/${id}`, {
      headers: { 'if-match': '*' },
    });
    expect(del.status).toBe(204);
    expect((await api.call('admin', 'GET', '/custom-policies')).status).toBe(200);
  });

  it('10.4 POST /policies/simulate returns the decision and determining policies', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/policies/simulate', {
      body: {
        principal: { kind: 'user', id: 'u1', role: 'admin', teams: [] },
        action: 'seeCatalog',
        resource: { type: 'Org' },
      },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).decision).toBe('allow');
    expect((rec(res.body).determiningPolicies as unknown[]).length).toBeGreaterThan(0);
    const member = await api.call('admin', 'POST', '/policies/simulate', {
      body: {
        principal: { kind: 'user', id: 'u2', role: 'member', teams: [] },
        action: 'policy.edit',
        resource: { type: 'Org' },
      },
    });
    expect(rec(member.body).decision).toBe('deny');
    expect(api.uow.audits).toHaveLength(0);
    expect((await api.call('managerOwn', 'POST', '/policies/simulate', { body: {} })).status).toBe(
      403,
    );
  });
});
