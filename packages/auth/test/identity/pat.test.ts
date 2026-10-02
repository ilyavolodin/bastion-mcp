import { describe, expect, it } from 'vitest';
import {
  generatePatToken,
  hashPatToken,
  IdentityNotFoundError,
  IdentityValidationError,
  PAT_PATTERN,
  PatService,
} from '../../src/identity';
import { FakeClock, MemoryPats, MemoryRevocations } from './helpers';

const setup = (maxDays = 90) => {
  const clock = new FakeClock();
  const pats = new MemoryPats();
  const revocations = new MemoryRevocations();
  const service = new PatService({
    pats,
    revocations,
    clock,
    policy: { patMaxDays: async () => maxDays },
  });
  return { clock, pats, revocations, service };
};

const base = { principalId: 'u', principalType: 'user' as const, name: 'n', scopes: ['mcp'] };

describe('9.3 personal access tokens', () => {
  it('9.3 token is bst_pat_ + base62 of 32 random bytes, stored only as SHA-256', async () => {
    const { service, pats } = setup();
    const { token, record } = await service.create({ ...base, name: 'ci' });
    expect(token).toMatch(PAT_PATTERN);
    expect(record.tokenSha256).toBe(hashPatToken(token));
    expect(JSON.stringify([...pats.rows.values()])).not.toContain(token);
  });

  it('9.3 generated tokens are distinct and extreme byte values still produce valid tokens', () => {
    expect(generatePatToken()).not.toBe(generatePatToken());
    expect(generatePatToken(() => new Uint8Array(32))).toMatch(PAT_PATTERN);
    expect(generatePatToken(() => new Uint8Array(32).fill(255))).toMatch(PAT_PATTERN);
  });

  it('22.5 default expiry is 90 days, capped by the admin maximum', async () => {
    const a = setup();
    const r = await a.service.create(base);
    expect(r.record.expiresAt.getTime()).toBe(a.clock.now() + 90 * 86_400_000);
    const b = setup(30);
    const r2 = await b.service.create(base);
    expect(r2.record.expiresAt.getTime()).toBe(b.clock.now() + 30 * 86_400_000);
  });

  it('22.5 rejects an expiry beyond the admin maximum or non-positive', async () => {
    const { service } = setup(90);
    await expect(service.create({ ...base, expiresInDays: 91 })).rejects.toBeInstanceOf(
      IdentityValidationError,
    );
    await expect(service.create({ ...base, expiresInDays: 0 })).rejects.toBeInstanceOf(
      IdentityValidationError,
    );
    await expect(service.create({ ...base, expiresInDays: 90 })).resolves.toBeTruthy();
  });

  it('9.3 rejects empty, unknown and offline_access scopes and bad names', async () => {
    const { service } = setup();
    for (const scopes of [[], ['admin'], ['offline_access']]) {
      await expect(service.create({ ...base, scopes })).rejects.toBeInstanceOf(
        IdentityValidationError,
      );
    }
    await expect(service.create({ ...base, name: '' })).rejects.toBeInstanceOf(
      IdentityValidationError,
    );
  });

  it('9.3 lists metadata without hashes and keeps endpoint restriction', async () => {
    const { service } = setup();
    await service.create({ ...base, principalType: 'service', name: 'a', endpointId: 'e1' });
    const list = await service.list('u');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'a',
      endpointId: 'e1',
      principalType: 'service',
      revoked: false,
    });
    expect(Object.keys(list[0] ?? {})).not.toContain('tokenSha256');
  });

  it('9.3 revoke sets revoked_at and publishes on bastion:revoke', async () => {
    const { service, pats, revocations } = setup();
    const { record } = await service.create(base);
    await service.revoke(record.id, { ownerId: 'u' });
    expect(pats.rows.get(record.id)?.revokedAt).not.toBeNull();
    expect(revocations.events).toEqual([
      { kind: 'pat', principalId: 'u', tokenId: record.id, tokenSha256: record.tokenSha256 },
    ]);
  });

  it('9.3 revoke of a foreign or unknown token is a not-found', async () => {
    const { service } = setup();
    const { record } = await service.create(base);
    await expect(service.revoke(record.id, { ownerId: 'other' })).rejects.toBeInstanceOf(
      IdentityNotFoundError,
    );
    await expect(service.revoke('nope', {})).rejects.toBeInstanceOf(IdentityNotFoundError);
  });

  it('9.1 revoking all of a principal writes the watermark, revokes PATs and publishes', async () => {
    const { service, pats, revocations, clock } = setup();
    await service.create(base);
    await service.revokeAll('u');
    expect(revocations.watermarks.get('u')).toBe(clock.seconds);
    expect([...pats.rows.values()].every((r) => r.revokedAt !== null)).toBe(true);
    expect(revocations.events.some((e) => e.kind === 'principal')).toBe(true);
  });
});
