import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildAad,
  CachingKmsProvider,
  type DecryptInput,
  decryptSecret,
  encryptSecret,
  rewrapAll,
  rewrapBatch,
  SecretIntegrityError,
  SecretVault,
} from '../src';
import { FakeClock, FakeKms, MemoryRepo } from './helpers';

const base = { scope: 'user', ownerId: 'u-1', name: 'github-token', version: 1 } as const;

const seal = async (
  kms: FakeKms,
  plaintext: string,
  over: { name?: string; version?: number } = {},
): Promise<DecryptInput> => {
  const input = { ...base, ...over };
  return { ...input, ...(await encryptSecret(kms, { ...input, plaintext })) };
};

describe('envelope encryption', () => {
  it('22.3 round-trips any value (property)', async () => {
    const kms = new FakeKms();
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.nat(1000),
        async (pt, name, version) => {
          const rec = await seal(kms, pt, { name, version });
          expect((await decryptSecret(kms, rec)).toString('utf8')).toBe(pt);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('22.3 wraps each secret with its own DEK and a random 96-bit IV', async () => {
    const kms = new FakeKms();
    const a = await seal(kms, 'same');
    const b = await seal(kms, 'same');
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.iv).toHaveLength(12);
    expect(a.authTag).toHaveLength(16);
    expect(a.kekRef).toBe('fake:v1');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('22.3 AAD is scope|owner_id|name|version', () => {
    expect(buildAad(base).toString()).toBe('user|u-1|github-token|1');
    expect(buildAad({ ...base, scope: 'system', ownerId: null }).toString()).toBe(
      'system||github-token|1',
    );
  });

  it('22.3 rejects tampering with every field (property)', async () => {
    const kms = new FakeKms();
    const rec = await seal(kms, 'top secret value');
    const flip = (b: Buffer, i: number) => {
      const c = Buffer.from(b);
      c[i % c.length] = (c[i % c.length] ?? 0) ^ 1;
      return c;
    };
    await fc.assert(
      fc.asyncProperty(fc.nat(63), async (i) => {
        const variants: DecryptInput[] = [
          { ...rec, ciphertext: flip(rec.ciphertext, i) },
          { ...rec, iv: flip(rec.iv, i) },
          { ...rec, authTag: flip(rec.authTag, i) },
          { ...rec, wrappedDek: flip(rec.wrappedDek, i) },
        ];
        for (const v of variants) await expect(decryptSecret(kms, v)).rejects.toThrow();
      }),
      { numRuns: 40 },
    );
  });

  it('22.3 rejects an AAD mismatch in scope, owner, name and version', async () => {
    const kms = new FakeKms();
    const rec = await seal(kms, 'v');
    const wrong: Partial<DecryptInput>[] = [
      { scope: 'org' },
      { ownerId: 'u-2' },
      { ownerId: null },
      { name: 'other' },
      { version: 2 },
    ];
    for (const w of wrong) {
      await expect(decryptSecret(kms, { ...rec, ...w })).rejects.toBeInstanceOf(
        SecretIntegrityError,
      );
    }
  });

  it('22.3 rejects malformed iv and a malformed DEK', async () => {
    const kms = new FakeKms();
    const rec = await seal(kms, 'v');
    await expect(decryptSecret(kms, { ...rec, iv: randomBytes(5) })).rejects.toBeInstanceOf(
      SecretIntegrityError,
    );
    await expect(decryptSecret(kms, { ...rec, wrappedDek: randomBytes(5) })).rejects.toThrow(
      /malformed data key/,
    );
  });

  it('22.3 accepts Buffer plaintext', async () => {
    const kms = new FakeKms();
    const sealed = await encryptSecret(kms, { ...base, plaintext: Buffer.from([1, 2, 3]) });
    expect([...(await decryptSecret(kms, { ...base, ...sealed }))]).toEqual([1, 2, 3]);
  });
});

describe('SecretVault', () => {
  it('22.3 stores, reveals and versions a secret', async () => {
    const repo = new MemoryRepo();
    const vault = new SecretVault(new FakeKms(), repo);
    const key = { scope: 'user', ownerId: 'u1', name: 'k' } as const;
    const m1 = await vault.put({ ...key, plaintext: 'one' });
    expect(m1.version).toBe(1);
    const m2 = await vault.put({ ...key, plaintext: 'two' });
    expect(m2.version).toBe(2);
    expect(m2.id).toBe(m1.id);
    expect(await vault.revealString(key)).toBe('two');
    expect(await vault.has(key)).toBe(true);
    expect(await vault.delete(key)).toBe(true);
    await expect(vault.reveal(key)).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  it('14 list returns names and metadata only, never ciphertext or wrapped keys', async () => {
    const vault = new SecretVault(new FakeKms(), new MemoryRepo());
    await vault.put({ scope: 'org', ownerId: null, name: 'a', plaintext: 'secret-value' });
    const listed = await vault.list({ scope: 'org', ownerId: null });
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'kekRef',
      'name',
      'ownerId',
      'scope',
      'updatedAt',
      'version',
    ]);
    expect(JSON.stringify(listed)).not.toContain('secret-value');
  });

  it('22.3 a row moved to another owner cannot be decrypted', async () => {
    const repo = new MemoryRepo();
    const vault = new SecretVault(new FakeKms(), repo);
    await vault.put({ scope: 'user', ownerId: 'u1', name: 'k', plaintext: 'x' });
    const row = await repo.get({ scope: 'user', ownerId: 'u1', name: 'k' });
    if (!row) throw new Error('missing');
    await repo.put({ ...row, ownerId: 'u2' });
    await expect(vault.reveal({ scope: 'user', ownerId: 'u2', name: 'k' })).rejects.toBeInstanceOf(
      SecretIntegrityError,
    );
  });
});

describe('DEK cache', () => {
  const setup = async () => {
    const clock = new FakeClock();
    const kms = new FakeKms();
    const cache = new CachingKmsProvider(kms, { clock });
    const vault = new SecretVault(cache, new MemoryRepo());
    const key = { scope: 'user', ownerId: 'u1', name: 'k' } as const;
    await vault.put({ ...key, plaintext: 'v' });
    return { clock, kms, cache, vault, key };
  };

  it('21.3 survives a KMS outage for 15 minutes, then fails', async () => {
    const { clock, kms, vault, key } = await setup();
    expect(await vault.revealString(key)).toBe('v');
    kms.down = true;
    clock.advance(14 * 60_000);
    expect(await vault.revealString(key)).toBe('v');
    clock.advance(2 * 60_000);
    await expect(vault.reveal(key)).rejects.toThrow('kms down');
  });

  it('21.3 caches unwrapped DEKs so repeated reads hit the KMS once', async () => {
    const { kms, vault, key } = await setup();
    await vault.reveal(key);
    await vault.reveal(key);
    expect(kms.unwrapCalls).toBe(1);
  });

  it('21.3 evicts the least recently used key beyond 1,000', async () => {
    const kms = new FakeKms();
    const cache = new CachingKmsProvider(kms, { clock: new FakeClock() });
    const sealed = await Promise.all(
      Array.from({ length: 1001 }, (_, i) => {
        const dek = Buffer.alloc(32);
        dek.writeUInt32BE(i, 0);
        return kms.wrap(dek);
      }),
    );
    for (const w of sealed) await cache.unwrap(w, 'fake:v1');
    expect(cache.size).toBe(1000);
    const before = kms.unwrapCalls;
    await cache.unwrap(sealed[0] as Buffer, 'fake:v1');
    expect(kms.unwrapCalls).toBe(before + 1);
    await cache.unwrap(sealed[1000] as Buffer, 'fake:v1');
    expect(kms.unwrapCalls).toBe(before + 1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('21.3 recent use protects a key from eviction', async () => {
    const kms = new FakeKms();
    const cache = new CachingKmsProvider(kms, { clock: new FakeClock(), maxKeys: 2 });
    const [a, b, c] = (await Promise.all([1, 2, 3].map((n) => kms.wrap(Buffer.alloc(32, n))))) as [
      Buffer,
      Buffer,
      Buffer,
    ];
    await cache.unwrap(a, 'r');
    await cache.unwrap(b, 'r');
    await cache.unwrap(a, 'r');
    await cache.unwrap(c, 'r');
    const n = kms.unwrapCalls;
    await cache.unwrap(a, 'r');
    expect(kms.unwrapCalls).toBe(n);
    await cache.unwrap(b, 'r');
    expect(kms.unwrapCalls).toBe(n + 1);
  });

  it('22.3 delegates wrap, health and kekRef', async () => {
    const { cache, kms } = await setup();
    expect(cache.kekRef).toBe(kms.kekRef);
    expect((await cache.health()).ok).toBe(true);
    expect((await cache.wrap(Buffer.alloc(32))).length).toBe(32);
  });
});

describe('KEK rotation', () => {
  it('22.3 re-wraps DEKs under the new KEK without touching ciphertexts', async () => {
    const repo = new MemoryRepo();
    const oldKms = new FakeKms('fake:v1');
    const vault = new SecretVault(oldKms, repo);
    for (let i = 0; i < 5; i++) {
      await vault.put({ scope: 'org', ownerId: null, name: `s${i}`, plaintext: `v${i}` });
    }
    const snapshot = new Map(
      [...repo.rows.values()].map((r) => [r.id, { ct: r.ciphertext, iv: r.iv, tag: r.authTag }]),
    );
    // A new KEK reference that can still unwrap rows wrapped under the old one.
    const newKms = new FakeKms('fake:v2', oldKms.mask);
    const result = await rewrapAll(repo, newKms, { batchSize: 2 });
    expect(result).toEqual({ rewrapped: 5, failed: [] });
    for (const r of repo.rows.values()) {
      const before = snapshot.get(r.id);
      expect(r.kekRef).toBe('fake:v2');
      expect(r.ciphertext.equals(before?.ct as Buffer)).toBe(true);
      expect(r.iv.equals(before?.iv as Buffer)).toBe(true);
      expect(r.authTag.equals(before?.tag as Buffer)).toBe(true);
      expect(r.version).toBe(1);
    }
    const reader = new SecretVault(newKms, repo);
    expect(await reader.revealString({ scope: 'org', ownerId: null, name: 's3' })).toBe('v3');
  });

  it('22.3 reports rows that fail and keeps going', async () => {
    const repo = new MemoryRepo();
    await new SecretVault(new FakeKms('fake:v1'), repo).put({
      scope: 'org',
      ownerId: null,
      name: 'a',
      plaintext: 'x',
    });
    const broken = new FakeKms('fake:v2');
    broken.down = true;
    const batch = await rewrapBatch(repo, broken);
    expect(batch.failed).toHaveLength(1);
    expect(batch.rewrapped).toBe(0);
    expect((await rewrapAll(repo, broken)).failed).toHaveLength(1);
    const ac = new AbortController();
    ac.abort();
    await expect(rewrapAll(repo, broken, { signal: ac.signal })).rejects.toThrow();
  });
});
