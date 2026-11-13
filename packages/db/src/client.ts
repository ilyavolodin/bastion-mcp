import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export type Db = {
  prisma: PrismaClient;
  close: () => Promise<void>;
};

/** Anything that can run raw queries: the client itself or an interactive transaction client. */
export type DbExecutor = Pick<
  PrismaClient,
  '$queryRaw' | '$queryRawUnsafe' | '$executeRaw' | '$executeRawUnsafe'
>;

/**
 * How long opening a connection may take. `pg` has NO default: a connect attempt that never completes (a stalled DNS
 * lookup, a dropped SYN, a half-open bridge) never errors either, so it holds its pool slot forever. Twenty of
 * those wedge the whole pool and `/readyz` with nothing in the logs. With a limit the attempt fails, the slot is
 * freed and the cause is logged.
 */
export const DB_CONNECT_TIMEOUT_MS = 10_000;
/** TCP keepalive on database sockets, so a connection that died silently is noticed instead of hanging. */
export const DB_KEEPALIVE_DELAY_MS = 10_000;

/** Connection settings every `pg` client and pool of this process must use (see `DB_CONNECT_TIMEOUT_MS`). */
export const pgConnectionOptions = (
  connectionString: string,
  connectTimeoutMs = DB_CONNECT_TIMEOUT_MS,
): {
  connectionString: string;
  connectionTimeoutMillis: number;
  keepAlive: true;
  keepAliveInitialDelayMillis: number;
} => ({
  connectionString,
  connectionTimeoutMillis: connectTimeoutMs,
  keepAlive: true,
  keepAliveInitialDelayMillis: DB_KEEPALIVE_DELAY_MS,
});

export type CreateDbOptions = { url: string; poolMax?: number; connectTimeoutMs?: number };

/** One Prisma client per process, over a pooled `pg` connection (`BASTION_DATABASE_POOL_MAX`). */
export const createDb = ({ url, poolMax = 20, connectTimeoutMs }: CreateDbOptions): Db => {
  const adapter = new PrismaPg({ ...pgConnectionOptions(url, connectTimeoutMs), max: poolMax });
  const prisma = new PrismaClient({ adapter });
  return { prisma, close: () => prisma.$disconnect() };
};
