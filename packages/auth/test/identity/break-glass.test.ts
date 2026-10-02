import { verifyPassword } from '@bastion-mcp/secrets';
import { describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  IdentityValidationError,
  type LocalAdminRepository,
  type LocalUser,
  localLoginEnabled,
  planBootstrapAdmin,
  verifyLocalLogin,
} from '../../src/identity';

class MemoryUsers implements LocalAdminRepository {
  users = new Map<string, LocalUser>();
  async findByEmail(email: string) {
    return this.users.get(email) ?? null;
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
}

describe('9.1 break-glass admin', () => {
  it('9.1 plans bootstrap only when configured, valid and the user does not exist', () => {
    expect(
      planBootstrapAdmin({ bootstrapEmail: ' Root@Example.com ', existingUserId: null }),
    ).toEqual({ action: 'create', email: 'root@example.com' });
    expect(planBootstrapAdmin({ bootstrapEmail: undefined, existingUserId: null })).toEqual({
      action: 'skip',
      reason: 'not_configured',
    });
    expect(planBootstrapAdmin({ bootstrapEmail: 'nope', existingUserId: null })).toEqual({
      action: 'skip',
      reason: 'invalid_email',
    });
    expect(planBootstrapAdmin({ bootstrapEmail: 'a@b.io', existingUserId: 'u' })).toEqual({
      action: 'skip',
      reason: 'already_exists',
    });
  });

  it('9.1 local login is enabled only without IdP connections or with BASTION_LOCAL_LOGIN=true', () => {
    expect(localLoginEnabled({ idpConnectionCount: 0, localLoginFlag: false })).toBe(true);
    expect(localLoginEnabled({ idpConnectionCount: 1, localLoginFlag: false })).toBe(false);
    expect(localLoginEnabled({ idpConnectionCount: 2, localLoginFlag: true })).toBe(true);
  });

  it('22.3 bootstraps an admin with an argon2id hash and returns a generated password once', async () => {
    const users = new MemoryUsers();
    const r = await bootstrapAdmin({ users }, { email: 'root@example.com' });
    expect(r.created).toBe(true);
    expect(r.generatedPassword).toHaveLength(33);
    const stored = users.users.get('root@example.com');
    expect(stored?.localPasswordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(stored?.localPasswordHash ?? '', r.generatedPassword ?? '')).toBe(
      true,
    );
    const again = await bootstrapAdmin({ users }, { email: 'root@example.com' });
    expect(again).toEqual({ created: false });
  });

  it('22.3 a supplied password is never echoed and must be long enough', async () => {
    const users = new MemoryUsers();
    const r = await bootstrapAdmin(
      { users },
      { email: 'a@b.io', password: 'correct horse battery' },
    );
    expect(r).toEqual({ created: true, email: 'a@b.io' });
    await expect(
      bootstrapAdmin({ users: new MemoryUsers() }, { email: 'a@b.io', password: 'short' }),
    ).rejects.toBeInstanceOf(IdentityValidationError);
    expect(await bootstrapAdmin({ users: new MemoryUsers() }, { email: undefined })).toEqual({
      created: false,
    });
  });

  it('9.1 local login verifies passwords and respects the enablement rule', async () => {
    const users = new MemoryUsers();
    await bootstrapAdmin(
      { users },
      { email: 'root@example.com', password: 'correct horse battery' },
    );
    const open = { idpConnectionCount: 0, localLoginFlag: false };
    expect(
      await verifyLocalLogin({ users }, open, 'Root@Example.com', 'correct horse battery'),
    ).toMatchObject({ orgRole: 'admin' });
    expect(await verifyLocalLogin({ users }, open, 'root@example.com', 'wrong')).toBeNull();
    expect(await verifyLocalLogin({ users }, open, 'nobody@example.com', 'x')).toBeNull();
    expect(
      await verifyLocalLogin(
        { users },
        { idpConnectionCount: 1, localLoginFlag: false },
        'root@example.com',
        'correct horse battery',
      ),
    ).toBeNull();
    expect(
      await verifyLocalLogin(
        { users },
        { idpConnectionCount: 1, localLoginFlag: true },
        'root@example.com',
        'correct horse battery',
      ),
    ).not.toBeNull();
    const u = users.users.get('root@example.com');
    if (u) u.status = 'deactivated';
    expect(
      await verifyLocalLogin({ users }, open, 'root@example.com', 'correct horse battery'),
    ).toBeNull();
  });
});
