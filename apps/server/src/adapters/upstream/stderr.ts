import { redisKeys, TTL } from '@bastion-mcp/core';
import type { StderrLogger, StderrSink } from '@bastion-mcp/sandbox';
import type { Infra } from '../../infra';

/** Sandbox stderr to the Redis stream `logs:{instanceId}`: last ~1,000 entries, expiring after 24 h (8.7, 16.3). */
export const createStderrSink = (infra: Infra): StderrSink => ({
  async write({ instanceId, line, ts }) {
    const key = redisKeys.sandboxLogs(instanceId);
    try {
      await infra.redis
        .multi()
        .xadd(key, 'MAXLEN', '~', 1000, '*', 'line', line, 'ts', String(ts))
        .expire(key, TTL.sandboxLogs)
        .exec();
    } catch {
      // log streaming is best effort; stderr is also kept in the instance's in-memory tail
    }
  },
});

/** OTEL log record `bastion.sandbox.stderr` (8.7, 15.1) through the structured logger. */
export const createStderrLogger =
  (infra: Infra): StderrLogger =>
  (record) => {
    infra.logger.info(
      {
        event: record.name,
        'bastion.instance.id': record.attributes['bastion.instance.id'],
        'bastion.installation.id': record.attributes['bastion.installation.id'],
      },
      record.body,
    );
  };

/** The last `tail` lines of an instance's stderr stream, oldest first. */
export const readStderrTail = async (
  infra: Infra,
  instanceId: string,
  tail: number,
): Promise<string[]> => {
  const entries = await infra.redis.xrevrange(
    redisKeys.sandboxLogs(instanceId),
    '+',
    '-',
    'COUNT',
    tail,
  );
  return entries
    .map(([, fields]) => {
      const i = fields.indexOf('line');
      return i >= 0 ? (fields[i + 1] ?? '') : '';
    })
    .reverse();
};
