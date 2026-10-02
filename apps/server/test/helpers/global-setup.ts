import {
  dockerAvailable,
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '@bastion-mcp/testkit';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/boot/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection string of the shared Postgres ('' without Docker). */
    pgAdminUrl: string;
    redisUrl: string;
  }
}

export const TEMPLATE_DB = 'bastion_template';
let pgc: TestPostgres | undefined;
let redisc: TestRedis | undefined;

/**
 * One Postgres and one Redis container per run. Migrations (our own runner) are applied once to a template
 * database; each test environment clones it in milliseconds.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!dockerAvailable()) {
    project.provide('pgAdminUrl', '');
    project.provide('redisUrl', '');
    return async () => {};
  }
  [pgc, redisc] = await Promise.all([startPostgres(), startRedis()]);
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  const templateUrl = new URL(pgc.url);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  await migrate(templateUrl.toString());
  project.provide('pgAdminUrl', pgc.url);
  project.provide('redisUrl', redisc.url);
  return async () => {
    await Promise.all([pgc?.stop(), redisc?.stop()]);
  };
}
