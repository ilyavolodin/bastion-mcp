import { SecretNotFoundError } from '@bastion-mcp/secrets';
import { describe, expect, it } from 'vitest';
import { marketplaceVisibleTo } from '../src/adapters/plugin-access';
import { semverOf } from '../src/adapters/plugin-content';
import { syncPluginSource } from '../src/adapters/plugin-sync';
import { createSecretStore } from '../src/adapters/secret-store';
import { scrubSecrets } from '../src/cli/config-io';
import { fakeInfra, manualClock } from './fake-infra';

const viewer = (over: Partial<Parameters<typeof marketplaceVisibleTo>[1]> = {}) => ({
  id: 'u1',
  orgRole: 'member' as const,
  teams: [{ teamId: 't1', role: 'member' as const }],
  ...over,
});

describe('25.4 marketplaceVisibleTo', () => {
  const row = (audience: unknown, ownerTeamId: string | null = null) => ({ audience, ownerTeamId });

  it('shows everything to admins', () => {
    expect(marketplaceVisibleTo(row({}), viewer({ orgRole: 'admin' }))).toBe(true);
  });
  it('shows an org-wide audience to everyone', () => {
    expect(marketplaceVisibleTo(row({ org: true }), viewer())).toBe(true);
  });
  it('matches listed users and listed teams', () => {
    expect(marketplaceVisibleTo(row({ userIds: ['u1'] }), viewer())).toBe(true);
    expect(marketplaceVisibleTo(row({ teamIds: ['t1'] }), viewer())).toBe(true);
    expect(marketplaceVisibleTo(row({ teamIds: ['t9'], userIds: ['u9'] }), viewer())).toBe(false);
  });
  it('shows a marketplace to the members of the owning team only', () => {
    expect(marketplaceVisibleTo(row({}, 't1'), viewer())).toBe(true);
    expect(marketplaceVisibleTo(row({}, 't2'), viewer())).toBe(false);
    expect(marketplaceVisibleTo(row(null, null), viewer())).toBe(false);
  });
});

describe('25.3 semverOf', () => {
  it('keeps semver, pads short numeric labels and falls back to 0.0.0', () => {
    expect(semverOf('1.2.3')).toBe('1.2.3');
    expect(semverOf('2')).toBe('2.0.0');
    expect(semverOf('2.1')).toBe('2.1.0');
    expect(semverOf('main')).toBe('0.0.0');
  });
});

describe('25.2 syncPluginSource', () => {
  it('reports an unknown source without touching anything else', async () => {
    const infra = fakeInfra({ repos: { pluginSources: { get: async () => null } } });
    expect(await syncPluginSource(infra, 'nope')).toEqual({
      imported: 0,
      updated: 0,
      errors: ['plugin source not found'],
    });
  });

  it('refuses to import when there is no active admin to own the drafts', async () => {
    const recorded: unknown[] = [];
    const infra = fakeInfra({
      clock: manualClock(Date.parse('2026-03-01T00:00:00Z')),
      repos: {
        pluginSources: {
          get: async () => ({ id: 's', gitUrl: 'https://x/y.git', ref: 'main', lastCommit: 'abc' }),
          recordSync: async (_id: string, record: unknown) => void recorded.push(record),
        },
      },
      db: { prisma: { user: { findFirst: async () => null } } },
    });
    const result = await syncPluginSource(infra, 's');
    expect(result.errors).toEqual(['no active admin to own imported drafts']);
    expect(recorded).toEqual([
      {
        lastCommit: 'abc',
        lastSync: {
          at: '2026-03-01T00:00:00.000Z',
          imported: 0,
          updated: 0,
          errors: ['no active admin to own imported drafts'],
          ok: false,
        },
      },
    ]);
    expect(result.imported).toBe(0);
  });
});

describe('9.2 createSecretStore', () => {
  const ref = { scope: 'installation', ownerId: 'i', name: 'token' } as never;

  it('puts through the vault and returns the id', async () => {
    const seen: unknown[] = [];
    const store = createSecretStore(
      {
        put: async (input: unknown) => {
          seen.push(input);
          return { id: 'sec-1' };
        },
      } as never,
      {} as never,
      {} as never,
    );
    expect(await store.put(ref, 'plain')).toEqual({ id: 'sec-1' });
    expect(seen[0]).toMatchObject({ plaintext: 'plain', name: 'token' });
  });

  it('reveal returns null for a missing secret and rethrows other failures', async () => {
    const vault = (error: Error) => ({ revealString: async () => Promise.reject(error) }) as never;
    const missing = createSecretStore(
      vault(new SecretNotFoundError('x') as Error),
      {} as never,
      {} as never,
    );
    expect(await missing.reveal(ref)).toBeNull();
    const broken = createSecretStore(vault(new Error('kms down')), {} as never, {} as never);
    await expect(broken.reveal(ref)).rejects.toThrow('kms down');
  });

  it('revealById is null for an unknown id', async () => {
    const store = createSecretStore(
      {} as never,
      { getById: async () => null } as never,
      {} as never,
    );
    expect(await store.revealById('nope')).toBeNull();
  });

  it('delete goes to the vault', async () => {
    const deleted: unknown[] = [];
    const store = createSecretStore(
      { delete: async (r: unknown) => void deleted.push(r) } as never,
      {} as never,
      {} as never,
    );
    await store.delete(ref);
    expect(deleted).toEqual([ref]);
  });
});

describe('20.1 scrubSecrets', () => {
  it('removes secret-looking keys at any depth, in arrays too', () => {
    expect(
      scrubSecrets({
        name: 'a',
        clientSecret: 'x',
        nested: { accessToken: 'y', keep: 1, list: [{ password: 'p', ok: true }] },
        ciphertext: 'z',
        when: new Date(0),
      }),
    ).toEqual({ name: 'a', nested: { keep: 1, list: [{ ok: true }] }, when: new Date(0) });
  });

  it('passes scalars through', () => {
    expect(scrubSecrets('x')).toBe('x');
    expect(scrubSecrets(null)).toBeNull();
    expect(scrubSecrets(3)).toBe(3);
  });
});
