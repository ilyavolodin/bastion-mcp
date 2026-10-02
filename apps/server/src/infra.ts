import { join } from 'node:path';
import { ScimStoreConflictError } from '@bastion-mcp/auth';
import { type BastionConfig, newId, REDIS_CHANNELS } from '@bastion-mcp/core';
import {
  createDb,
  createRepositories,
  createSecretRepository,
  type Db,
  type Repositories,
  type RepositoryDeps,
  withTransaction,
} from '@bastion-mcp/db';
import { computeConfigHash } from '@bastion-mcp/router';
import {
  CachingKmsProvider,
  createKmsProvider,
  type KmsProvider,
  SecretVault,
} from '@bastion-mcp/secrets';
import { type BastionMetrics, createLogger, createMetrics } from '@bastion-mcp/telemetry';
import { metrics as otelMetrics, type Tracer, trace } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { RedisPubSub } from './adapters/redis';
import { createSecretStore } from './adapters/secret-store';
import { defaultWorkerId, type ServerOptions } from './config';

export type AppLogger = Logger;

/** What every adapter and role needs: connections, crypto and repositories (CONTRIBUTING rule 6). */
export type Infra = {
  config: BastionConfig;
  options: ServerOptions;
  workerId: string;
  logger: AppLogger;
  metrics: BastionMetrics;
  tracer: Tracer;
  db: Db;
  redis: Redis;
  pubsub: RedisPubSub;
  kms: KmsProvider;
  vault: SecretVault;
  secretStore: ReturnType<typeof createSecretStore>;
  /** Repositories bound to the pool; mutations bump `config_versions` and publish `bastion:config` after commit. */
  repos: Repositories;
  /** `withTransaction` with the same publishing and repository deps. */
  transaction: <T>(fn: Parameters<typeof withTransaction<T>>[1]) => Promise<T>;
  /** Publishes a message on a Redis channel; never throws. */
  publish: (channel: string, message: unknown) => Promise<void>;
  /** A fresh Redis connection (subscribers, blocking commands). */
  duplicateRedis: () => Redis;
  clock: { now(): number };
  close: () => Promise<void>;
};

export const configMessage = (event: { scope: string; id: string; version?: bigint | number }) =>
  JSON.stringify({
    topic: event.scope,
    scope: event.scope,
    id: event.id,
    ...(event.version === undefined ? {} : { version: String(event.version) }),
  });

export const createInfra = (config: BastionConfig, options: ServerOptions = {}): Infra => {
  const workerId = options.workerId ?? defaultWorkerId(process.env);
  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'bastion', role: config.role, worker: workerId },
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  });
  const metrics = createMetrics(otelMetrics.getMeter('bastion'));
  const tracer = trace.getTracer('bastion');

  const db = createDb({ url: config.databaseUrl, poolMax: config.databasePoolMax });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  redis.on('error', (error) => logger.warn({ err: error.message }, 'redis error'));
  const pubsub = new RedisPubSub(redis);

  const kms = new CachingKmsProvider(
    createKmsProvider({
      kms: config.kms,
      kmsKey:
        config.kmsKey ?? (config.kms === 'local' ? join(config.dataDir, 'kek.key') : undefined),
    }),
  );
  const vault = new SecretVault(kms, createSecretRepository(db.prisma));

  const publish = async (channel: string, message: unknown): Promise<void> => {
    try {
      await redis.publish(channel, typeof message === 'string' ? message : JSON.stringify(message));
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), channel },
        'publish failed',
      );
    }
  };

  const repoOptions = {
    publishConfig: (event: { scope: string; id: string; version: bigint }) =>
      publish(REDIS_CHANNELS.config, configMessage(event)),
    onPublishError: (error: unknown) =>
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'config publish failed',
      ),
  };
  const deps: RepositoryDeps = {
    scimConflictError: (message) => new ScimStoreConflictError(message),
    secretVault: vault,
    configHash: (input) =>
      computeConfigHash({
        catalogVersionId: input.catalogVersionId,
        variables: input.variables,
      }),
  };
  const repos = createRepositories(db.prisma, deps, repoOptions);
  const secretStore = createSecretStore(vault, repos.secrets, kms);

  return {
    config,
    options,
    workerId,
    logger,
    metrics,
    tracer,
    db,
    redis,
    pubsub,
    kms,
    vault,
    secretStore,
    repos,
    transaction: (fn) => withTransaction(db.prisma, fn, { ...repoOptions, deps }),
    publish,
    duplicateRedis: () => {
      const r = redis.duplicate();
      r.on('error', () => undefined);
      return r;
    },
    clock: { now: () => Date.now() },
    async close() {
      await pubsub.close();
      await redis.quit().catch(() => undefined);
      await db.close().catch(() => undefined);
    },
  };
};

export { newId };
