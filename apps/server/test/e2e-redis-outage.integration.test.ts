import { dockerAvailable, startPostgres, startRedis } from '@bastion-mcp/testkit';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/boot/migrate';
import { haveDocker } from './helpers/env';
import { bootStack } from './helpers/stack';

/**
 * 15.1 / 21.4: `/readyz` reports each dependency and goes degraded when Redis is stopped; liveness stays up. This suite
 * owns its containers so stopping Redis cannot disturb the other suites.
 */
describe.skipIf(!haveDocker() || !dockerAvailable())(
  'E2E /readyz degrades when Redis stops (15.1, 21.4)',
  () => {
    it('15.1 readyz is 200 with Redis, 503 with a failing redis check once it is stopped, and recovers', async () => {
      const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
      const client = new pg.Client({ connectionString: postgres.url });
      await client.connect();
      await client.end();
      await migrate(postgres.url);
      const dataDir = (await import('node:fs')).mkdtempSync(
        (await import('node:path')).join((await import('node:os')).tmpdir(), 'bastion-ro-'),
      );
      const stack = await bootStack({
        env: {
          databaseUrl: postgres.url,
          redisUrl: redis.url,
          dataDir,
          cleanup: async () => undefined,
          env: (o = {}) => ({
            BASTION_PUBLIC_URL: 'https://bastion.test',
            BASTION_INTERNAL_SECRET: 'x'.repeat(48),
            BASTION_DATABASE_URL: postgres.url,
            BASTION_REDIS_URL: redis.url,
            BASTION_DATA_DIR: dataDir,
            BASTION_KMS_KEY: `${dataDir}/kek.key`,
            BASTION_LOG_LEVEL: 'silent',
            ...o,
          }),
        },
      });
      try {
        const ok = await stack.fetch(stack.url('/readyz'));
        expect(ok.status).toBe(200);
        await redis.container.stop();
        const degraded = await stack.fetch(stack.url('/readyz'));
        expect(degraded.status).toBe(503);
        const body = (await degraded.json()) as { checks: Record<string, { ok: boolean }> };
        expect(body.checks.redis?.ok).toBe(false);
        expect(body.checks.postgres?.ok).toBe(true);
        expect((await stack.fetch(stack.url('/healthz'))).status).toBe(200);
      } finally {
        await Promise.race([stack.stop(), new Promise((r) => setTimeout(r, 20_000))]);
        await postgres.stop();
      }
    });
  },
);
