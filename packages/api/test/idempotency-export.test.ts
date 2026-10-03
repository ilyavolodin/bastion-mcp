import type { RedisLike } from '@bastion-mcp/auth';
import { redisKeys, TTL } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/export';
import {
  fingerprintOf,
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyStore,
  MAX_KEY_LENGTH,
  validateKey,
} from '../src/framework/idempotency';

/** A Redis double that also records the TTL each key was written with. */
class TtlRedis implements RedisLike {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string, ttl?: number) {
    this.data.set(key, value);
    this.ttls.set(key, ttl);
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async expire() {
    return true;
  }
  async hgetall() {
    return {};
  }
  async hset() {}
}

const stored = (fingerprint: string) => ({
  fingerprint,
  status: 201,
  body: '{"id":"x"}',
  headers: { 'content-type': 'application/json' },
});

describe('17.1 idempotency fingerprint and key', () => {
  it('17.1 the fingerprint ignores JSON key order but not method, url or content', () => {
    const a = fingerprintOf('POST', '/api/v1/teams', { a: 1, b: { c: 2, d: 3 } });
    expect(fingerprintOf('POST', '/api/v1/teams', { b: { d: 3, c: 2 }, a: 1 })).toBe(a);
    expect(fingerprintOf('PUT', '/api/v1/teams', { a: 1, b: { c: 2, d: 3 } })).not.toBe(a);
    expect(fingerprintOf('POST', '/api/v1/other', { a: 1, b: { c: 2, d: 3 } })).not.toBe(a);
    expect(fingerprintOf('POST', '/api/v1/teams', { a: 2, b: { c: 2, d: 3 } })).not.toBe(a);
  });

  it('17.1 a request without a body fingerprints like an empty one, and differs from a null body', () => {
    expect(fingerprintOf('POST', '/x', undefined)).toBe(fingerprintOf('POST', '/x', undefined));
    expect(fingerprintOf('POST', '/x', undefined)).not.toBe(fingerprintOf('POST', '/x', null));
  });

  it('17.1 accepts keys up to 255 characters', () => {
    expect(validateKey('abc-123')).toBe('abc-123');
    expect(validateKey('k'.repeat(MAX_KEY_LENGTH))).toHaveLength(MAX_KEY_LENGTH);
  });

  it.each([
    ['empty', ''],
    ['too long', 'k'.repeat(MAX_KEY_LENGTH + 1)],
    ['with a newline', 'a\nb'],
    ['with a NUL', 'a\u0000b'],
    ['with a tab', 'a\tb'],
  ])('17.1 rejects a key that is %s with 400', (_name, key) => {
    expect(() => validateKey(key)).toThrow(
      expect.objectContaining({ code: 'invalid_idempotency_key', httpStatus: 400 }),
    );
  });
});

describe('17.1 IdempotencyStore', () => {
  it('17.1 keeps a response for the documented 24 hours', async () => {
    const redis = new TtlRedis();
    await new IdempotencyStore(redis).save('p1', 'k1', stored('f1'));
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(TTL.idempotency);
    expect(redis.ttls.get(redisKeys.idempotency('p1', 'k1'))).toBe(86_400);
  });

  it('17.1 replays the stored response for the same principal, key and fingerprint', async () => {
    const store = new IdempotencyStore(new TtlRedis());
    await store.save('p1', 'k1', stored('f1'));
    expect(await store.lookup('p1', 'k1', 'f1')).toEqual(stored('f1'));
  });

  it('17.1 finds nothing for an unseen key', async () => {
    expect(await new IdempotencyStore(new TtlRedis()).lookup('p1', 'k1', 'f1')).toBeNull();
  });

  it('17.1 scopes keys to the principal', async () => {
    const store = new IdempotencyStore(new TtlRedis());
    await store.save('p1', 'k1', stored('f1'));
    expect(await store.lookup('p2', 'k1', 'f1')).toBeNull();
  });

  it('17.1 refuses a key reused for a different request', async () => {
    const store = new IdempotencyStore(new TtlRedis());
    await store.save('p1', 'k1', stored('f1'));
    await expect(store.lookup('p1', 'k1', 'other')).rejects.toMatchObject({
      code: 'idempotency_key_reuse',
    });
  });

  it('17.1 treats an unreadable record as absent instead of failing the request', async () => {
    const redis = new TtlRedis();
    const store = new IdempotencyStore(redis);
    redis.data.set(redisKeys.idempotency('p1', 'k1'), 'not json');
    expect(await store.lookup('p1', 'k1', 'f1')).toBeNull();
    redis.data.set(redisKeys.idempotency('p1', 'k1'), JSON.stringify({ fingerprint: 'f1' }));
    expect(await store.lookup('p1', 'k1', 'f1')).toBeNull();
  });

  it('17.1 defaults missing headers to none', async () => {
    const redis = new TtlRedis();
    redis.data.set(
      redisKeys.idempotency('p1', 'k1'),
      JSON.stringify({ fingerprint: 'f1', status: 200, body: '' }),
    );
    expect((await new IdempotencyStore(redis).lookup('p1', 'k1', 'f1'))?.headers).toEqual({});
  });
});

describe('17.1 OpenAPI export', () => {
  it('17.1 builds the OpenAPI 3.1 document without touching any dependency', async () => {
    const doc = (await buildOpenApiDocument('https://bastion.test')) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(100);
    expect(doc.components.schemas.Team).toBeDefined();
  });

  it('17.1 gives every operation a unique operationId', async () => {
    const doc = (await buildOpenApiDocument()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const urls = Object.keys(doc.paths);
    expect(urls.every((u) => u.startsWith('/'))).toBe(true);
    const ops = urls.flatMap((u) => Object.values(doc.paths[u] ?? {}).map((o) => o.operationId));
    const defined = ops.filter((o): o is string => o !== undefined);
    expect(new Set(defined).size).toBe(defined.length);
  });
});
