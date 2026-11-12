import { loadConfig, newId } from '@bastion-mcp/core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, readBackup, restoreBackup } from '../src/backup/backup';
import { createMaintenance } from '../src/backup/maintenance';
import { seedDefaults } from '../src/boot/seed';
import { exportConfig, importConfig } from '../src/cli/config-io';
import { createInfra, type Infra } from '../src/infra';
import { publishKeyChange } from '../src/scheduler/tasks/keys';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

const NIL = '00000000-0000-0000-0000-000000000000';
const settle = () => new Promise((r) => setTimeout(r, 400));

describe.skipIf(!haveDocker())(
  '4.3 the config events written by backup, config import and key rotation',
  () => {
    let env: TestEnv;
    let infra: Infra;
    let sub: Redis;
    let messages: string[] = [];
    const adminId = newId();
    let entryIds: string[] = [];

    beforeAll(async () => {
      env = await createTestEnv();
      infra = createInfra(loadConfig(env.env()), { skipMigrationCheck: true });
      await seedDefaults(infra);
      await infra.db.prisma.user.create({
        data: { id: adminId, email: 'admin@example.test', displayName: 'Admin', orgRole: 'admin' },
      });
      for (const slug of ['wire-a', 'wire-b']) {
        await infra.repos.catalogEntries.create({
          slug,
          displayName: slug,
          description: 'for the wire format',
          createdBy: adminId,
        });
      }
      entryIds = (
        await infra.db.prisma.catalogEntry.findMany({
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      ).map((e) => e.id);
      sub = new Redis(env.redisUrl);
      await sub.subscribe('bastion:config');
      sub.on('message', (_c, m) => void messages.push(m));
      await settle();
      messages = [];
    });
    afterAll(async () => {
      await sub.quit();
      await infra.close();
      await env.cleanup();
    });

    /** The exact JSON of a bump up to the version, which the database chooses; it is a decimal string. */
    const bump = (scope: string, id: string): { prefix: string } => ({
      prefix: `{"topic":"${scope}","scope":"${scope}","id":"${id}","version":"`,
    });
    const expectedBumps = () => [bump('org', NIL), ...entryIds.map((id) => bump('catalog', id))];
    const expectMessages = (expected: ({ prefix: string } | string)[]) => {
      expect(messages).toHaveLength(expected.length);
      expected.forEach((e, i) => {
        const got = messages[i] ?? '';
        if (typeof e === 'string') expect(got).toBe(e);
        else {
          expect(got.startsWith(e.prefix), got).toBe(true);
          expect(got.slice(e.prefix.length)).toMatch(/^[0-9]+"}$/);
        }
      });
    };

    it('a config import publishes the org event, then one catalog event per entry, exact JSON', async () => {
      const doc = await exportConfig(infra);
      messages = [];
      await importConfig(infra, doc);
      await settle();
      expectMessages(expectedBumps());
    });

    it('a merge restore publishes the org event, then one catalog event per entry, exact JSON', async () => {
      const { file } = await createBackup(infra, 'a long enough passphrase', { id: adminId });
      const { document } = await readBackup(file, 'a long enough passphrase');
      const maintenance = createMaintenance(infra.redis);
      await maintenance.set(false, 'test');
      messages = [];
      await restoreBackup(infra, maintenance, document, { mode: 'merge', actorId: adminId });
      await settle();
      expectMessages(expectedBumps());
    });

    it('a replace restore adds the signing and state key events without a version', async () => {
      const { file } = await createBackup(infra, 'a long enough passphrase', { id: adminId });
      const { document } = await readBackup(file, 'a long enough passphrase');
      const maintenance = createMaintenance(infra.redis);
      await maintenance.set(true, 'test');
      messages = [];
      await restoreBackup(infra, maintenance, document, { mode: 'replace', actorId: adminId });
      await settle();
      expectMessages([
        ...expectedBumps(),
        `{"topic":"signing_keys","scope":"signing_keys","id":"${NIL}"}`,
        `{"topic":"state_keys","scope":"state_keys","id":"${NIL}"}`,
      ]);
    });

    it('a key change publishes topic, scope org and the purpose as id', async () => {
      messages = [];
      await publishKeyChange(infra, ['as', 'state']);
      await settle();
      expectMessages([
        '{"topic":"signing_keys","scope":"org","id":"as"}',
        '{"topic":"state_keys","scope":"org","id":"state"}',
      ]);
    });
  },
);
