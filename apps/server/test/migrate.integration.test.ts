import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundledMigrations, migrate, migrationStatus } from '../src/boot/migrate';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

describe.skipIf(!haveDocker())('20.1 bastion migrate', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it('20.1 the template database is migrated: nothing is pending and a second run is a no-op', async () => {
    const client = new pg.Client({ connectionString: env.databaseUrl });
    await client.connect();
    try {
      const status = await migrationStatus(client);
      expect(status.pending).toEqual([]);
      expect(status.applied).toEqual(bundledMigrations().map((m) => m.name));
      const again = await migrate(env.databaseUrl);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toBe(status.applied.length);
    } finally {
      await client.end();
    }
  });
});
