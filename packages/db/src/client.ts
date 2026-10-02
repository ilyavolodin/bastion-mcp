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

export type CreateDbOptions = { url: string; poolMax?: number };

/** One Prisma client per process, over a pooled `pg` connection (`BASTION_DATABASE_POOL_MAX`). */
export const createDb = ({ url, poolMax = 20 }: CreateDbOptions): Db => {
  const adapter = new PrismaPg({ connectionString: url, max: poolMax });
  const prisma = new PrismaClient({ adapter });
  return { prisma, close: () => prisma.$disconnect() };
};
