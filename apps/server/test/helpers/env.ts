import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { TEMPLATE_DB } from './global-setup';

/** True when the global setup started containers; suites use `describe.skipIf(!haveDocker())`. */
export const haveDocker = (): boolean => inject('pgAdminUrl') !== '';

export type TestEnv = {
  databaseUrl: string;
  redisUrl: string;
  dataDir: string;
  /** Environment variables for `loadConfig`; override per test. */
  env: (overrides?: Record<string, string>) => Record<string, string>;
  cleanup: () => Promise<void>;
};

/** A fresh database (cloned from the migrated template), a flushed Redis and a temp data directory. */
export const createTestEnv = async (): Promise<TestEnv> => {
  const adminUrl = inject('pgAdminUrl');
  const redisUrl = inject('redisUrl');
  const name = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const redis = new Redis(redisUrl);
  await redis.flushall();
  await redis.quit();
  const dataDir = mkdtempSync(join(tmpdir(), 'bastion-'));
  return {
    databaseUrl: url.toString(),
    redisUrl,
    dataDir,
    env: (overrides = {}) => ({
      BASTION_PUBLIC_URL: 'https://bastion.test',
      BASTION_INTERNAL_SECRET: 'x'.repeat(48),
      BASTION_DATABASE_URL: url.toString(),
      BASTION_REDIS_URL: redisUrl,
      BASTION_DATA_DIR: dataDir,
      BASTION_KMS_KEY: join(dataDir, 'kek.key'),
      BASTION_LOG_LEVEL: 'warn',
      BASTION_OSV_CHECK: 'false',
      ...overrides,
    }),
    async cleanup() {
      rmSync(dataDir, { recursive: true, force: true });
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
};
