import { describe, expect, it } from 'vitest';
import { CachingKmsProvider, DEK_CACHE_TTL_MS } from '../src';
import { FakeClock, FakeKms } from './helpers';

describe('21.3 DEK cache expiry', () => {
  it('21.3 an entry expires exactly at the TTL and is re-fetched', async () => {
    const clock = new FakeClock();
    const kms = new FakeKms();
    const cache = new CachingKmsProvider(kms, { clock });
    const wrapped = await kms.wrap(Buffer.alloc(32, 7));
    await cache.unwrap(wrapped, 'r');
    clock.advance(DEK_CACHE_TTL_MS - 1);
    await cache.unwrap(wrapped, 'r');
    expect(kms.unwrapCalls).toBe(1);
    clock.advance(1);
    await cache.unwrap(wrapped, 'r');
    expect(kms.unwrapCalls).toBe(2);
  });

  it('21.3 callers get copies: zeroing a returned DEK does not poison the cache', async () => {
    const kms = new FakeKms();
    const cache = new CachingKmsProvider(kms, { clock: new FakeClock() });
    const wrapped = await kms.wrap(Buffer.alloc(32, 9));
    (await cache.unwrap(wrapped, 'r')).fill(0);
    expect([...(await cache.unwrap(wrapped, 'r'))]).toEqual(new Array(32).fill(9));
  });
});
