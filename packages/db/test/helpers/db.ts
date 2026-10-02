import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, inject } from 'vitest';
import { createDb, type Db } from '../../src/client';
import { TEMPLATE_DB } from '../global-setup';

/** True when the shared Postgres is up (Docker present); integration suites use `describe.skipIf(!enabled)`. */
export const dbEnabled = (): boolean => inject('pgAdminUrl') !== '';

export type TestDbHandle = { readonly db: Db; readonly url: string };

/** Clones the migrated template into a private database for the calling test file. */
export const useTestDb = (): TestDbHandle => {
  const state: { db?: Db; url?: string; admin?: Db; name?: string } = {};
  beforeAll(async () => {
    const adminUrl = inject('pgAdminUrl');
    if (adminUrl === '') return;
    const name = `t_${randomBytes(6).toString('hex')}`;
    state.admin = createDb({ url: adminUrl, poolMax: 1 });
    await state.admin.prisma.$executeRawUnsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    state.name = name;
    state.url = url.toString();
    state.db = createDb({ url: state.url, poolMax: 8 });
  });
  afterAll(async () => {
    await state.db?.close();
    if (state.admin && state.name) {
      await state.admin.prisma.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS ${state.name} WITH (FORCE)`,
      );
    }
    await state.admin?.close();
  });
  return {
    get db(): Db {
      if (!state.db) throw new Error('test database not started');
      return state.db;
    },
    get url(): string {
      return state.url ?? '';
    },
  };
};
