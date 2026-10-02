import { randomBytes } from 'node:crypto';
import { redisKeys, SCOPES, TTL } from '@bastion-mcp/core';
import {
  type Clock,
  type PrincipalStore,
  type RedisLike,
  type RevocationStore,
  systemClock,
} from '../ports';
import { buildPrincipal, type Principal } from '../principal';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SessionData = { principalId: string; createdAt: number; lastSeenAt: number };

export type SessionServiceDeps = {
  redis: RedisLike;
  principals: PrincipalStore;
  revocations: RevocationStore;
  clock?: Clock;
  random?: (n: number) => Uint8Array;
};

export type CreatedSession = {
  id: string;
  csrfToken: string;
  /** Idle TTL in seconds, for the cookie `Max-Age`. */
  ttlSeconds: number;
};

/** Browser sessions backed by Redis `uisess:{id}` (9.2): 12 h sliding, 7 d absolute. */
export class SessionService {
  private readonly clock: Clock;
  private readonly random: (n: number) => Uint8Array;
  constructor(private readonly deps: SessionServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? randomBytes;
  }

  async create(input: { principalId: string }): Promise<CreatedSession> {
    const id = Buffer.from(this.random(32)).toString('base64url');
    const csrfToken = Buffer.from(this.random(32)).toString('base64url');
    const now = this.clock.now();
    // The watermark compares whole seconds: a session created in the second of a revocation (a login right after a
    // password reset) starts in the next one instead of being born revoked.
    const watermark = await this.deps.revocations.getWatermark(input.principalId);
    const createdAt =
      watermark !== null && Math.floor(now / 1000) <= watermark ? (watermark + 1) * 1000 : now;
    const key = redisKeys.uiSession(id);
    await this.deps.redis.hset(key, {
      principalId: input.principalId,
      createdAt: String(createdAt),
      lastSeenAt: String(now),
    });
    await this.deps.redis.expire(key, TTL.uiSession);
    return { id, csrfToken, ttlSeconds: TTL.uiSession };
  }

  /** Returns the session and slides its idle TTL, never past the absolute deadline. */
  async validate(id: string): Promise<SessionData | null> {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const key = redisKeys.uiSession(id);
    const fields = await this.deps.redis.hgetall(key);
    const createdAt = Number(fields.createdAt);
    if (!fields.principalId || !Number.isFinite(createdAt)) return null;
    const now = this.clock.now();
    const remainingMs = createdAt + TTL.uiSessionAbsolute * 1000 - now;
    if (remainingMs <= 0) {
      await this.deps.redis.del(key);
      return null;
    }
    await this.deps.redis.expire(key, Math.min(TTL.uiSession, Math.ceil(remainingMs / 1000)));
    return { principalId: fields.principalId, createdAt, lastSeenAt: now };
  }

  /** Resolves the session to a principal: active, and not older than the revocation watermark (9.1). */
  async authenticate(id: string): Promise<Principal | null> {
    const session = await this.validate(id);
    if (!session) return null;
    const record = await this.deps.principals.getPrincipal(session.principalId);
    if (!record?.active) return null;
    const watermark = await this.deps.revocations.getWatermark(record.id);
    if (watermark !== null && Math.floor(session.createdAt / 1000) <= watermark) return null;
    return buildPrincipal(record, {
      authMethod: 'session',
      scopes: [SCOPES.apiRead, SCOPES.apiWrite],
    });
  }

  /**
   * Revokes every session of the principal (and its access tokens) through the watermark (9.1) and publishes the
   * event. `keep` names the session that stays valid (the one that just changed the password): it is re-stamped
   * to start in the next second, because the watermark compares whole seconds.
   */
  async revokeAll(principalId: string, options: { keep?: string } = {}): Promise<void> {
    const nowS = Math.floor(this.clock.now() / 1000);
    await this.deps.revocations.setWatermark(principalId, nowS);
    if (options.keep && SESSION_ID_PATTERN.test(options.keep)) {
      const key = redisKeys.uiSession(options.keep);
      const fields = await this.deps.redis.hgetall(key);
      if (fields.principalId === principalId) {
        await this.deps.redis.hset(key, { createdAt: String((nowS + 1) * 1000) });
      }
    }
    await this.deps.revocations.publish({ kind: 'principal', principalId, at: nowS });
  }

  async destroy(id: string): Promise<void> {
    if (SESSION_ID_PATTERN.test(id)) await this.deps.redis.del(redisKeys.uiSession(id));
  }
}
