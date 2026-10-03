/**
 * Legacy sessions in Redis (6.2): `sess:{sessionId}` hash with a 30 minute sliding TTL and `sesslist:{principalId}`, a
 * sorted set scored by `lastSeenAt` that caps the open sessions per principal (oldest idle evicted first).
 */
import { randomBytes } from 'node:crypto';
import { REDIS_CHANNELS, redisKeys, TTL } from '@bastion-mcp/core';
import { z } from 'zod';
import type { DownstreamRedis } from '../../ports';
import { type ClientCaps, type ClientInfo, LOGGING_LEVELS, type LoggingLevel } from '../../types';

export type SessionRecord = {
  id: string;
  principalId: string;
  tokenHash: string;
  endpointId: string;
  protocolVersion: string;
  clientCapabilities: ClientCaps;
  clientInfo?: ClientInfo | undefined;
  logLevel?: LoggingLevel | undefined;
  createdAt: number;
  lastSeenAt: number;
  /** Subscribed resource URIs (an addition to the hash of 6.2, kept as JSON). */
  subs: string[];
};

const jsonField = <T extends z.ZodType>(schema: T, fallback: z.infer<T>) =>
  z.string().transform((raw, ctx): z.infer<T> => {
    if (raw === '') return fallback;
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid JSON field' });
      return z.NEVER;
    }
  });

const hashSchema = z.object({
  principalId: z.string().min(1),
  tokenHash: z.string(),
  endpointId: z.string(),
  protocolVersion: z.string().min(1),
  clientCapabilities: jsonField(z.record(z.string(), z.unknown()), {}),
  clientInfo: jsonField(
    z.object({ name: z.string(), version: z.string(), title: z.string().optional() }).optional(),
    undefined,
  ),
  logLevel: z.string().optional(),
  createdAt: z.coerce.number(),
  lastSeenAt: z.coerce.number(),
  subs: jsonField(z.array(z.string()), []).optional(),
});

export const newSessionId = (): string => randomBytes(32).toString('base64url');

export const closeMessage = JSON.stringify({ type: 'close' });

export class LegacySessionStore {
  constructor(
    private readonly redis: DownstreamRedis,
    private readonly options: { maxPerPrincipal: number; now: () => number },
  ) {}

  async get(id: string): Promise<SessionRecord | null> {
    if (id.length === 0 || id.length > 128) return null;
    const raw = await this.redis.hgetall(redisKeys.session(id));
    if (Object.keys(raw).length === 0) return null;
    const parsed = hashSchema.safeParse(raw);
    if (!parsed.success) return null;
    const d = parsed.data;
    const level = LOGGING_LEVELS.find((l) => l === d.logLevel);
    return {
      id,
      principalId: d.principalId,
      tokenHash: d.tokenHash,
      endpointId: d.endpointId,
      protocolVersion: d.protocolVersion,
      clientCapabilities: d.clientCapabilities,
      clientInfo: d.clientInfo,
      logLevel: level,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      subs: d.subs ?? [],
    };
  }

  /** Creates the session and evicts the oldest idle ones beyond the per-principal cap. */
  async create(
    record: Omit<SessionRecord, 'createdAt' | 'lastSeenAt' | 'subs'>,
  ): Promise<SessionRecord> {
    const now = this.options.now();
    const key = redisKeys.session(record.id);
    await this.redis.hset(key, {
      principalId: record.principalId,
      tokenHash: record.tokenHash,
      endpointId: record.endpointId,
      protocolVersion: record.protocolVersion,
      clientCapabilities: JSON.stringify(record.clientCapabilities),
      clientInfo: record.clientInfo === undefined ? '' : JSON.stringify(record.clientInfo),
      logLevel: record.logLevel ?? '',
      createdAt: String(now),
      lastSeenAt: String(now),
      subs: '[]',
    });
    await this.redis.expire(key, TTL.legacySession);
    const list = redisKeys.sessionList(record.principalId);
    await this.redis.zadd(list, now, record.id);
    await this.redis.expire(list, TTL.legacySession);
    const over = (await this.redis.zcard(list)) - this.options.maxPerPrincipal;
    if (over > 0) {
      const oldest = (await this.redis.zrange(list, 0, over)).filter((id) => id !== record.id);
      for (const id of oldest.slice(0, over)) await this.end(id, record.principalId);
    }
    return { ...record, createdAt: now, lastSeenAt: now, subs: [] };
  }

  /** Sliding TTL and `lastSeenAt` on every request. */
  async touch(session: SessionRecord): Promise<void> {
    const now = this.options.now();
    const key = redisKeys.session(session.id);
    await this.redis.hset(key, { lastSeenAt: String(now) });
    await this.redis.expire(key, TTL.legacySession);
    const list = redisKeys.sessionList(session.principalId);
    await this.redis.zadd(list, now, session.id);
    await this.redis.expire(list, TTL.legacySession);
  }

  async setLogLevel(id: string, level: string): Promise<void> {
    await this.redis.hset(redisKeys.session(id), { logLevel: level });
  }

  async setSubs(id: string, subs: readonly string[]): Promise<void> {
    await this.redis.hset(redisKeys.session(id), { subs: JSON.stringify(subs) });
  }

  /** Deletes the session and tells every worker holding one of its streams to close them. */
  async end(id: string, principalId: string): Promise<void> {
    await this.redis.del(redisKeys.session(id));
    await this.redis.zrem(redisKeys.sessionList(principalId), id);
    await this.redis.publish(REDIS_CHANNELS.session(id), closeMessage);
  }
}
