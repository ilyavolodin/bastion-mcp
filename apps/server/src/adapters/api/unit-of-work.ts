/**
 * `UnitOfWork` and `Publisher` of the control-plane API (17.1): every mutating route runs in one transaction that
 * holds the resource writes, the config-version bumps and the audit events (hash chain, 15.6). After COMMIT the bumps
 * are published on `bastion:config` (4.3) and the route's `afterCommit` hooks run (SSE events, deactivation work);
 * a rollback publishes nothing.
 */
import type { Publisher, Tx, UnitOfWork } from '@bastion-mcp/api';
import { REDIS_CHANNELS } from '@bastion-mcp/core';
import {
  flushUnit,
  NIL_UUID,
  Prisma,
  publishAfterCommit,
  TX_OPTIONS,
  UnitState,
} from '@bastion-mcp/db';
import { configMessage, type Infra } from '../../infra';
import { createResourceStore, loadResourceStoreMeta } from './resource-store';

const isConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';

export const createPublisher = (infra: Pick<Infra, 'publish'>): Publisher => ({
  publish: (channel, message) => infra.publish(channel, message),
});

export type ApiPersistence = {
  /** Reads outside any transaction (`ApiDeps.store`). */
  store: ReturnType<typeof createResourceStore>;
  uow: UnitOfWork;
  publisher: Publisher;
};

/** Builds the store, unit of work and publisher the API needs; loads the schema metadata once. */
export const createApiPersistence = async (
  infra: Pick<Infra, 'db' | 'publish' | 'logger'>,
): Promise<ApiPersistence> => {
  const prisma = infra.db.prisma;
  const meta = await loadResourceStoreMeta(prisma);
  const store = createResourceStore(prisma, meta);

  const publishConfig = (event: { scope: string; id: string; version: bigint }) =>
    infra.publish(REDIS_CHANNELS.config, configMessage(event));
  const onPublishError = (error: unknown): void =>
    infra.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'config publish failed',
    );

  const uow: UnitOfWork = {
    async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const attempts = 3;
      for (let attempt = 1; ; attempt += 1) {
        const unit = new UnitState();
        try {
          const done = await prisma.$transaction(async (db) => {
            // The API leaves `created_by` of rules to the audit actor: the insert uses the nil placeholder and the
            // actor of the `.create` audit event is written over it before the commit (15.6).
            const creators: {
              table: 'policy_rules' | 'custom_policies';
              id: string;
              actor: string;
            }[] = [];
            const tx: Tx = {
              store: createResourceStore(db, meta, { unit }),
              async audit(event) {
                unit.audits.push(event);
                const table =
                  event.targetType === 'policy_rule'
                    ? 'policy_rules'
                    : event.targetType === 'custom_policy'
                      ? 'custom_policies'
                      : undefined;
                if (table && event.action.endsWith('.create') && event.targetId && event.actorId) {
                  creators.push({ table, id: event.targetId, actor: event.actorId });
                }
              },
              afterCommit(hook) {
                unit.afterCommit.push(hook);
              },
            };
            const out = await fn(tx);
            for (const c of creators) {
              // Raw SQL: the version (`updated_at`) of the row the route just returned must not move.
              await db.$executeRaw(
                Prisma.sql`UPDATE ${Prisma.raw(c.table)} SET created_by = ${c.actor}::uuid WHERE id = ${c.id}::uuid AND created_by = ${NIL_UUID}::uuid`,
              );
            }
            return { out, events: await flushUnit(db, unit) };
          }, TX_OPTIONS);
          await publishAfterCommit({ publishConfig, onPublishError }, done.events, unit);
          return done.out;
        } catch (error) {
          if (attempt >= attempts || !isConflict(error)) throw error;
        }
      }
    },
  };
  return { store, uow, publisher: createPublisher(infra) };
};
