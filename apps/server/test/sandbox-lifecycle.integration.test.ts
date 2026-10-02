import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { LocalProcessDriver } from './helpers/local-process-driver';
import {
  connectClient,
  seedInstallation,
  startTestWorker,
  type TestWorker,
  textOf,
} from './helpers/worker-harness';

/**
 * Journey (k): a stdio package server through the REAL apps/runner (HTTP API, bearer binding, NDJSON start events,
 * WebSocket stdio frames, real child process) via the test-only `LocalProcessDriver`, because bubblewrap does not
 * exist on Windows. Only the package installer is replaced (see local-process-driver.ts).
 */
describe.skipIf(!haveDocker())('8 sandbox lifecycle through the real runner', () => {
  let env: TestEnv;
  let driver1: LocalProcessDriver;
  let driver2: LocalProcessDriver;
  let w1: TestWorker;
  let w2: TestWorker;
  let seeded: Awaited<ReturnType<typeof seedInstallation>>;

  beforeAll(async () => {
    env = await createTestEnv();
    driver1 = new LocalProcessDriver();
    driver2 = driver1.sibling();
    w1 = await startTestWorker(env, { workerId: 'sandbox-one', driver: driver1 });
    w2 = await startTestWorker(env, { workerId: 'sandbox-two', driver: driver2 });
    seeded = await seedInstallation(w1.infra, {
      email: 'dev@example.com',
      slug: 'stdio',
      spec: {
        type: 'package',
        runtime: 'npm',
        identifier: 'fake-stdio',
        version: '1.0.0',
        auth: { mode: 'none' },
      },
    });
  });

  afterAll(async () => {
    await w1?.stop();
    await w2?.stop();
    await driver1?.runners.closeAll();
    await env?.cleanup();
  });

  const echo = async (worker: TestWorker, text: string): Promise<string> => {
    const client = await connectClient(worker.base, seeded.userId);
    try {
      return textOf(await client.callTool({ name: 'stdio__echo', arguments: { text } }));
    } finally {
      await client.close();
    }
  };

  it('8.3 / 8.6 the first call claims a sandbox, binds the runner, installs and starts the stdio server', async () => {
    expect(await echo(w1, 'first')).toBe('first');
    expect(driver1.createCount).toBe(1);
    expect(driver1.runners.installs).toHaveLength(1);
    expect(driver1.runners.installs[0]).toMatchObject({
      identifier: 'fake-stdio',
      version: '1.0.0',
    });
    const record = await w1.infra.repos.instances.getForInstallation(seeded.installationId);
    expect(record?.sandbox?.address).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('22.3 the runner token is stored encrypted as the system secret runner:<instanceId>', async () => {
    const record = await w1.infra.repos.instances.getForInstallation(seeded.installationId);
    const stored = await w1.infra.vault.revealString({
      scope: 'system',
      ownerId: null,
      name: `runner:${record?.id}`,
    });
    expect(stored).toHaveLength(48);
    const row = await w1.infra.db.prisma.secret.findFirst({
      where: { name: `runner:${record?.id}` },
    });
    expect(Buffer.from(row?.ciphertext ?? []).toString('utf8')).not.toContain(stored);
  });

  it('8.6 a crashing server is restarted on the next call', async () => {
    const client = await connectClient(w1.base, seeded.userId);
    try {
      await client.callTool({ name: 'stdio__crash', arguments: {} }).catch(() => undefined);
    } finally {
      await client.close();
    }
    await expect.poll(() => echo(w1, 'again'), { timeout: 30_000, interval: 500 }).toBe('again');
  });

  it('21.2 a second worker re-attaches to the running sandbox after the owner stops', async () => {
    const before = driver1.createCount;
    await w1.worker.stop(500);
    expect(await echo(w2, 'attached')).toBe('attached');
    expect(driver2.attachCount).toBeGreaterThan(0);
    expect(driver2.createCount).toBe(0);
    expect(driver1.createCount).toBe(before);
  });

  it('8.6 an idle stop destroys the sandbox, deletes its token, and the next call starts a fresh one', async () => {
    const record = await w2.infra.repos.instances.getForInstallation(seeded.installationId);
    const id = record?.id ?? '';
    await w2.worker.runtime.instances.stop(id, 'idle');
    expect(driver2.destroyed.length).toBeGreaterThan(0);
    await expect(
      w2.infra.vault.revealString({ scope: 'system', ownerId: null, name: `runner:${id}` }),
    ).rejects.toThrow();
    expect(await echo(w2, 'fresh')).toBe('fresh');
    expect(driver2.createCount).toBe(1);
  });
});
