import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** True when a Docker daemon answers; integration suites use it to skip instead of failing. */
export const dockerAvailable = (): boolean => {
  // A busy machine (every package's tests start at once) can answer `docker info` slowly. A timeout must not be
  // read as "no Docker": that would skip the integration suites silently and let the run pass without them.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 60_000 });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ETIMEDOUT') return false;
    }
  }
  return false;
};

export type TestPostgres = {
  url: string;
  stop: () => Promise<void>;
  container: StartedPostgreSqlContainer;
};

/** Postgres 17 (23.1 integration layer). Each call is an isolated, disposable database. */
export const startPostgres = async (): Promise<TestPostgres> => {
  const container = await new PostgreSqlContainer('postgres:17')
    .withDatabase('bastion')
    .withUsername('bastion')
    .withPassword('bastion')
    .start();
  return {
    url: container.getConnectionUri(),
    container,
    stop: async () => {
      await container.stop();
    },
  };
};

export type TestRedis = { url: string; stop: () => Promise<void>; container: StartedTestContainer };

/** Valkey 8, wire-compatible with Redis 7 (23.1). */
export const startRedis = async (): Promise<TestRedis> => {
  const container = await new GenericContainer('valkey/valkey:8')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    container,
    stop: async () => {
      await container.stop();
    },
  };
};
