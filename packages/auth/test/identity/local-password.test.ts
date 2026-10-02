import { verifyPassword } from '@bastion-mcp/secrets';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  changeLocalPassword,
  checkPasswordPolicy,
  type LocalAdminRepository,
  type LocalPasswordRepository,
  type LocalUser,
  MAX_LOCAL_PASSWORD_LENGTH,
  resetLocalPassword,
  SessionService,
} from '../../src/identity';
import {
  FakeClock,
  MemoryPrincipals,
  MemoryRedis,
  MemoryRevocations,
  memberRecord,
} from './helpers';

class MemoryUsers implements LocalAdminRepository, LocalPasswordRepository {
  users = new Map<string, LocalUser>();
  audits: unknown[] = [];
  async findByEmail(email: string) {
    return this.users.get(email) ?? null;
  }
  async findById(id: string) {
    return [...this.users.values()].find((u) => u.id === id) ?? null;
  }
  async createLocalAdmin(i: { id: string; email: string; passwordHash: string }) {
    this.users.set(i.email, {
      id: i.id,
      email: i.email,
      orgRole: 'admin',
      status: 'active',
      localPasswordHash: i.passwordHash,
    });
  }
  async setPasswordHash(input: { userId: string; passwordHash: string; audit?: unknown }) {
    const u = await this.findById(input.userId);
    if (u) u.localPasswordHash = input.passwordHash;
    this.audits.push(input.audit);
  }
}

const seed = async (password = 'initial password 123') => {
  const users = new MemoryUsers();
  await bootstrapAdmin({ users }, { email: 'root@acme.test', password });
  const id = (await users.findByEmail('root@acme.test'))?.id ?? '';
  return { users, id };
};

describe('9.1 local password policy', () => {
  it('9.1 requires 12 to 256 characters', () => {
    expect(checkPasswordPolicy('short', { email: 'a@b.test' })).toMatch(/at least 12/);
    expect(
      checkPasswordPolicy('x1'.repeat(MAX_LOCAL_PASSWORD_LENGTH), { email: 'a@b.test' }),
    ).toMatch(/at most/);
    expect(checkPasswordPolicy('violet-harbor-lantern-4', { email: 'a@b.test' })).toBeNull();
  });

  it('9.1 rejects the current password, the e-mail name, repeats and common passwords', () => {
    const ctx = { email: 'jordan.lee@acme.test', current: 'old password value' };
    expect(checkPasswordPolicy('old password value', ctx)).toMatch(/different/);
    expect(checkPasswordPolicy('xx-Jordan.Lee-xx-1', ctx)).toMatch(/e-mail/);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa', ctx)).toMatch(/repeat/);
    expect(checkPasswordPolicy('password1234', ctx)).toMatch(/common/);
  });

  it('9.1 property: any accepted password is within bounds and differs from the current one', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 40 }), (pw, current) => {
        const verdict = checkPasswordPolicy(pw, { email: 'u@x.test', current });
        if (verdict === null) {
          expect(pw.length).toBeGreaterThanOrEqual(12);
          expect(pw.length).toBeLessThanOrEqual(MAX_LOCAL_PASSWORD_LENGTH);
          expect(pw).not.toBe(current);
        }
      }),
    );
  });
});

describe('9.1 changeLocalPassword', () => {
  it('9.1 verifies the current password, stores a new argon2id hash and audits it', async () => {
    const { users, id } = await seed();
    const r = await changeLocalPassword(
      { users },
      {
        userId: id,
        currentPassword: 'initial password 123',
        newPassword: 'brand new passphrase 9',
      },
    );
    expect(r).toEqual({ ok: true });
    const hash = (await users.findById(id))?.localPasswordHash ?? '';
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'brand new passphrase 9')).toBe(true);
    expect(users.audits[0]).toMatchObject({
      action: 'user.password_change',
      actorType: 'user',
      actorId: id,
    });
  });

  it('9.1 audit can be left to the caller (the API writes its own event)', async () => {
    const { users, id } = await seed();
    const r = await changeLocalPassword(
      { users },
      {
        userId: id,
        currentPassword: 'initial password 123',
        newPassword: 'brand new passphrase 9',
      },
      { audit: false },
    );
    expect(r).toEqual({ ok: true });
    expect(users.audits).toEqual([undefined]);
  });

  it('9.1 a wrong current password changes nothing', async () => {
    const { users, id } = await seed();
    const before = (await users.findById(id))?.localPasswordHash;
    const r = await changeLocalPassword(
      { users },
      { userId: id, currentPassword: 'not the password', newPassword: 'brand new passphrase 9' },
    );
    expect(r).toEqual({ ok: false, reason: 'invalid_current' });
    expect((await users.findById(id))?.localPasswordHash).toBe(before);
  });

  it('9.1 refuses reuse of the current (for example the bootstrap) password', async () => {
    const { users, id } = await seed();
    const r = await changeLocalPassword(
      { users },
      { userId: id, currentPassword: 'initial password 123', newPassword: 'initial password 123' },
    );
    expect(r).toMatchObject({ ok: false, reason: 'policy' });
  });

  it('9.1 accounts without a local password (IdP users) are not supported', async () => {
    const users = new MemoryUsers();
    users.users.set('sso@acme.test', {
      id: 'u-sso',
      email: 'sso@acme.test',
      orgRole: 'member',
      status: 'active',
      localPasswordHash: null,
    });
    const r = await changeLocalPassword(
      { users },
      {
        userId: 'u-sso',
        currentPassword: 'whatever value here',
        newPassword: 'brand new passphrase 9',
      },
    );
    expect(r).toEqual({ ok: false, reason: 'not_local' });
  });

  it('9.1 a deactivated account cannot change its password', async () => {
    const { users, id } = await seed();
    const u = await users.findById(id);
    if (u) u.status = 'deactivated';
    const r = await changeLocalPassword(
      { users },
      {
        userId: id,
        currentPassword: 'initial password 123',
        newPassword: 'brand new passphrase 9',
      },
    );
    expect(r).toEqual({ ok: false, reason: 'invalid_current' });
  });
});

describe('20.1 resetLocalPassword', () => {
  it('20.1 generates a random password when none is supplied and audits as the system', async () => {
    const { users, id } = await seed();
    const r = await resetLocalPassword({ users }, { email: ' Root@Acme.test ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.userId).toBe(id);
    expect(r.generatedPassword).toHaveLength(33);
    const hash = (await users.findById(id))?.localPasswordHash ?? '';
    expect(await verifyPassword(hash, r.generatedPassword ?? '')).toBe(true);
    expect(await verifyPassword(hash, 'initial password 123')).toBe(false);
    expect(users.audits[0]).toMatchObject({ action: 'user.password_reset', actorType: 'system' });
  });

  it('20.1 sets a supplied password (and never returns it) after the policy check', async () => {
    const { users, id } = await seed();
    const r = await resetLocalPassword(
      { users },
      { email: 'root@acme.test', password: 'supplied by the admin 1' },
    );
    expect(r).toEqual({ ok: true, userId: id, email: 'root@acme.test' });
    expect(
      await verifyPassword(
        (await users.findById(id))?.localPasswordHash ?? '',
        'supplied by the admin 1',
      ),
    ).toBe(true);
    const weak = await resetLocalPassword(
      { users },
      { email: 'root@acme.test', password: 'short' },
    );
    expect(weak).toMatchObject({ ok: false, reason: 'policy' });
  });

  it('20.1 unknown e-mails and accounts without a local password are reported', async () => {
    const { users } = await seed();
    expect(await resetLocalPassword({ users }, { email: 'nobody@acme.test' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    users.users.set('sso@acme.test', {
      id: 'u2',
      email: 'sso@acme.test',
      orgRole: 'member',
      status: 'active',
      localPasswordHash: null,
    });
    expect(await resetLocalPassword({ users }, { email: 'sso@acme.test' })).toEqual({
      ok: false,
      reason: 'not_local',
    });
  });
});

describe('9.1 SessionService.revokeAll', () => {
  const setup = () => {
    const clock = new FakeClock();
    const redis = new MemoryRedis(clock);
    const principals = new MemoryPrincipals();
    principals.records.set('u1', memberRecord('u1'));
    const revocations = new MemoryRevocations();
    return {
      sessions: new SessionService({ redis, principals, revocations, clock }),
      revocations,
    };
  };

  it('9.1 revokes every session and publishes the principal event', async () => {
    const { sessions, revocations } = setup();
    const a = await sessions.create({ principalId: 'u1' });
    const b = await sessions.create({ principalId: 'u1' });
    await sessions.revokeAll('u1');
    expect(await sessions.authenticate(a.id)).toBeNull();
    expect(await sessions.authenticate(b.id)).toBeNull();
    expect(revocations.events.some((e) => e.kind === 'principal')).toBe(true);
  });

  it('9.1 a session created in the second of a revocation is valid (login right after a reset)', async () => {
    const { sessions } = setup();
    await sessions.revokeAll('u1');
    const fresh = await sessions.create({ principalId: 'u1' });
    expect(await sessions.authenticate(fresh.id)).toMatchObject({ id: 'u1' });
  });

  it('9.1 keeps the named session and revokes the others, including ones from the same second', async () => {
    const { sessions } = setup();
    const keep = await sessions.create({ principalId: 'u1' });
    const other = await sessions.create({ principalId: 'u1' });
    await sessions.revokeAll('u1', { keep: keep.id });
    expect(await sessions.authenticate(other.id)).toBeNull();
    expect(await sessions.authenticate(keep.id)).toMatchObject({ id: 'u1' });
  });
});
