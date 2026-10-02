import type { RedisLike } from '@bastion-mcp/auth';
import { canonicalJson, redisKeys, sha256Hex } from '@bastion-mcp/core';
import { z } from 'zod';
import { ApiError, IdempotencyKeyReuseError } from '../errors';

/** 17.1: a replay within 24 hours returns the original response. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_KEY_LENGTH = 255;

const recordSchema = z.object({
  fingerprint: z.string(),
  status: z.number().int(),
  body: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
});
export type StoredResponse = z.infer<typeof recordSchema>;

export const fingerprintOf = (method: string, url: string, body: unknown): string =>
  sha256Hex(`${method} ${url}\n${body === undefined ? '' : canonicalJson(body)}`);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((c) => c.charCodeAt(0) < 0x20);

export const validateKey = (key: string): string => {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || hasControlCharacter(key)) {
    throw new ApiError('invalid_idempotency_key', 'Idempotency-Key is not valid', 400);
  }
  return key;
};

export class IdempotencyStore {
  constructor(private readonly redis: RedisLike) {}

  /** The stored response for this key, or `null`; throws when the key was used for another request. */
  async lookup(
    principalId: string,
    key: string,
    fingerprint: string,
  ): Promise<StoredResponse | null> {
    const raw = await this.redis.get(redisKeys.idempotency(principalId, key));
    if (raw === null) return null;
    let parsed: StoredResponse;
    try {
      parsed = recordSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
    if (parsed.fingerprint !== fingerprint) throw new IdempotencyKeyReuseError();
    return parsed;
  }

  async save(principalId: string, key: string, response: StoredResponse): Promise<void> {
    await this.redis.set(
      redisKeys.idempotency(principalId, key),
      JSON.stringify(response),
      IDEMPOTENCY_TTL_SECONDS,
    );
  }
}
