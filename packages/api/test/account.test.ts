import { afterEach, describe, expect, it } from 'vitest';
import type { PasswordChangeOutcome } from '../src/ports';
import { buildTestApi, type TestApi } from './helpers/harness';
import { W } from './helpers/world';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

type Call = { userId: string; currentPassword: string; newPassword: string };
const withOutcome = async (outcome: PasswordChangeOutcome) => {
  const calls: Call[] = [];
  api = await buildTestApi({
    overrides: {
      account: {
        changePassword: async (input) => {
          calls.push(input);
          return outcome;
        },
      },
    },
  });
  return calls;
};

const body = { currentPassword: 'old password 1', newPassword: 'a much better passphrase' };
const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe('9.1 POST /me/password', () => {
  it('9.1 changes only the caller own password and writes an audit event', async () => {
    const calls = await withOutcome({ ok: true });
    const res = await api?.call('member', 'POST', '/me/password', { body });
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual({ changed: true });
    expect(calls).toEqual([{ ...body, userId: W.memberA, sessionId: null }]);
    expect(api?.uow.audits.at(-1)).toMatchObject({
      action: 'user.password_change',
      targetId: W.memberA,
      actorId: W.memberA,
    });
  });

  it('9.1 every authenticated role may change its own password (no Cedar action)', async () => {
    await withOutcome({ ok: true });
    for (const actor of ['admin', 'managerOwn', 'member', 'auditor'] as const) {
      const res = await api?.call(actor, 'POST', '/me/password', { body });
      expect(res?.status, actor).toBe(200);
    }
  });

  it('9.1 a wrong current password is a field error and writes no audit event', async () => {
    await withOutcome({ ok: false, reason: 'invalid_current' });
    const before = api?.uow.audits.length;
    const res = await api?.call('member', 'POST', '/me/password', { body });
    expect(res?.status).toBe(400);
    expect(rec(res?.body).errors).toEqual([
      { path: 'currentPassword', message: 'The current password is not correct.' },
    ]);
    expect(api?.uow.audits.length).toBe(before);
  });

  it('9.1 a policy violation names the new password field', async () => {
    await withOutcome({ ok: false, reason: 'policy', message: 'That password is too common.' });
    const res = await api?.call('member', 'POST', '/me/password', { body });
    expect(res?.status).toBe(400);
    expect(rec(res?.body).errors).toEqual([
      { path: 'newPassword', message: 'That password is too common.' },
    ]);
  });

  it('9.1 IdP-managed accounts are told to change the password at the IdP', async () => {
    await withOutcome({ ok: false, reason: 'not_local' });
    const res = await api?.call('member', 'POST', '/me/password', { body });
    expect(res?.status).toBe(422);
    expect(String(rec(res?.body).detail)).toMatch(/identity provider/);
  });

  it('9.1 throttled attempts answer 429', async () => {
    await withOutcome({ ok: false, reason: 'throttled', retryAfterSeconds: 120 });
    const res = await api?.call('member', 'POST', '/me/password', { body });
    expect(res?.status).toBe(429);
  });

  it('9.1 service accounts have no password', async () => {
    const calls = await withOutcome({ ok: true });
    const res = await api?.call('service', 'POST', '/me/password', { body });
    expect(res?.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('9.1 rejects a body without both fields', async () => {
    await withOutcome({ ok: true });
    const res = await api?.call('member', 'POST', '/me/password', {
      body: { currentPassword: 'x' },
    });
    expect(res?.status).toBe(400);
  });
});
