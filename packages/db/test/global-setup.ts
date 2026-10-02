import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { dockerAvailable, startPostgres, type TestPostgres } from '@bastion-mcp/testkit';
import type { TestProject } from 'vitest/node';
import { createDb } from '../src/client';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection string of the shared Postgres ('' without Docker). */
    pgAdminUrl: string;
  }
}

export const TEMPLATE_DB = 'bastion_template';

let pg: TestPostgres | undefined;

/**
 * One Postgres container per test run; migrations are applied once to a template database and each
 * test file clones it (`CREATE DATABASE ... TEMPLATE`), which takes milliseconds.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!dockerAvailable()) {
    project.provide('pgAdminUrl', '');
    return async () => {};
  }
  pg = await startPostgres();
  const admin = createDb({ url: pg.url, poolMax: 1 });
  await admin.prisma.$executeRawUnsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.close();
  const templateUrl = new URL(pg.url);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  execFileSync('pnpm', ['prisma', 'migrate', 'deploy'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, BASTION_DATABASE_URL: templateUrl.toString() },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  project.provide('pgAdminUrl', pg.url);
  return async () => {
    await pg?.stop();
  };
}
