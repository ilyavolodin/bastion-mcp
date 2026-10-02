import { loadConfig } from '@bastion-mcp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdminUser } from '../src/boot/bootstrap-admin';
import { keyStoreOf } from '../src/boot/key-store';
import { assertMigrationsCurrent, PendingMigrationsError } from '../src/boot/preflight';
import { OFFICIAL_REGISTRY_URL, seedDefaults } from '../src/boot/seed';
import { createInfra, type Infra } from '../src/infra';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

describe.skipIf(!haveDocker())('19.2/22.5/9.1 boot: preflight, seed, bootstrap admin', () => {
  let env: TestEnv;
  let infra: Infra;
  const printed: { email: string; password: string }[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    infra = createInfra(
      loadConfig(env.env({ BASTION_BOOTSTRAP_ADMIN_EMAIL: 'Admin@Example.com' })),
      { printBootstrapPassword: (email, password) => void printed.push({ email, password }) },
    );
  });
  afterAll(async () => {
    await infra.close();
    await env.cleanup();
  });

  it('20.1 preflight accepts a fully migrated database and refuses a pending one', async () => {
    await expect(assertMigrationsCurrent(env.databaseUrl)).resolves.toMatchObject({ pending: [] });
    await infra.db.prisma.$executeRawUnsafe(
      `UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name LIKE '0003%'`,
    );
    await expect(assertMigrationsCurrent(env.databaseUrl)).rejects.toBeInstanceOf(
      PendingMigrationsError,
    );
    await infra.db.prisma.$executeRawUnsafe(
      `UPDATE "_prisma_migrations" SET finished_at = now() WHERE migration_name LIKE '0003%'`,
    );
  });

  it('19.2 seeds every default once and a second run changes nothing', async () => {
    const first = await seedDefaults(infra);
    expect(first.settings.length).toBeGreaterThan(5);
    expect(first.guardProfile).toBe(true);
    expect(first.registrySource).toBe(true);
    expect(first.limitRules).toBe(4);
    expect(first.keys.sort()).toEqual(['as', 'state', 'upstream-client']);

    const profile = await infra.repos.guardProfiles.getOrgDefault();
    expect(profile?.guards.length).toBe(4);
    expect((await infra.repos.orgSettings.get('guards')).orgDefaultProfileId).toBe(profile?.id);
    const sources = await infra.repos.registrySources.list();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      baseUrl: OFFICIAL_REGISTRY_URL,
      enabled: false,
      trust: 'official',
    });
    const store = keyStoreOf(infra);
    expect(await store.listSigningKeys('as')).toHaveLength(1);
    expect(await store.listStateKeys()).toHaveLength(1);

    const second = await seedDefaults(infra);
    expect(second).toEqual({
      settings: [],
      guardProfile: false,
      registrySource: false,
      limitRules: 0,
      keys: [],
    });
    expect(await infra.repos.limitRules.list()).toHaveLength(4);
    expect(await store.listSigningKeys('upstream-client')).toHaveLength(1);
  });

  it('19.2 seeding keeps an admin-edited setting', async () => {
    await infra.repos.orgSettings.set('personalInstalls', 'off');
    await seedDefaults(infra);
    expect(await infra.repos.orgSettings.get('personalInstalls')).toBe('off');
  });

  it('9.1 bootstrap admin prints a generated password once and never again', async () => {
    const first = await bootstrapAdminUser(infra);
    expect(first).toEqual({ created: true, email: 'admin@example.com' });
    expect(printed).toHaveLength(1);
    expect(printed[0]?.password.length).toBeGreaterThanOrEqual(12);
    const again = await bootstrapAdminUser(infra);
    expect(again.created).toBe(false);
    expect(printed).toHaveLength(1);
    const user = await infra.repos.users.findByEmail('admin@example.com');
    expect(user?.orgRole).toBe('admin');
  });
});
