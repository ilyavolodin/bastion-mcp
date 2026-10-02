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
 * 8.1, 8.3: a package server's environment variables and arguments reach the sandboxed process. The stdio fake
 * server runs behind the real runner (see `LocalProcessDriver`) and reports `process.env` and `process.argv`: a fixed
 * value, a `{{var.NAME}}` value taken from the installation's variables, and arguments with templates.
 */
describe.skipIf(!haveDocker())('8.1 environment variables and arguments reach the sandbox', () => {
  let env: TestEnv;
  let driver: LocalProcessDriver;
  let worker: TestWorker;
  let userId = '';

  beforeAll(async () => {
    env = await createTestEnv();
    driver = new LocalProcessDriver();
    worker = await startTestWorker(env, { workerId: 'env-one', driver });
    const seeded = await seedInstallation(worker.infra, {
      email: 'env@example.com',
      slug: 'envpkg',
      spec: {
        type: 'package',
        runtime: 'npm',
        identifier: 'fake-stdio',
        version: '1.0.0',
        auth: { mode: 'none' },
        environmentVariables: [
          { name: 'FIXED_ENV', value: 'fixed-value' },
          { name: 'GREETING_ENV', value: 'hello {{var.GREETING}}' },
        ],
        packageArguments: [
          { type: 'positional', value: 'serve' },
          { type: 'named', name: '--region', value: 'eu-{{var.GREETING}}' },
        ],
      },
    });
    userId = seeded.userId;
    const current = await worker.infra.repos.installations.getWithEtag(seeded.installationId);
    await worker.infra.repos.installations.update(
      seeded.installationId,
      { variables: { GREETING: 'world' } },
      { ifMatch: current?.etag ?? '*' },
    );
  });

  afterAll(async () => {
    await worker?.stop();
    await driver?.runners.closeAll();
    await env?.cleanup();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const client = await connectClient(worker.base, userId);
    try {
      return textOf(await client.callTool({ name: `envpkg__${name}`, arguments: args }));
    } finally {
      await client.close();
    }
  };

  it('8.1 a fixed value and a {{var.NAME}} value arrive in the process environment', async () => {
    expect(await call('getenv', { name: 'FIXED_ENV' })).toBe('fixed-value');
    expect(await call('getenv', { name: 'GREETING_ENV' })).toBe('hello world');
  });

  it('8.1 package arguments arrive in order, with templates resolved', async () => {
    expect(JSON.parse(await call('argv', {}))).toEqual(['serve', '--region', 'eu-world']);
  });
});
