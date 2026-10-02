import { describe, expect, it } from 'vitest';
import {
  ARGON2_OPTIONS,
  hashPassword,
  INTERNAL_MAX_SKEW_MS,
  INTERNAL_SIG_HEADER,
  INTERNAL_TS_HEADER,
  LOG_REDACT_PATHS,
  REDACTED,
  redactSecrets,
  scrub,
  signInternalRequest,
  verifyInternalRequest,
  verifyPassword,
} from '../src';

describe('password hashing', () => {
  it('22.3 uses argon2id, 64 MiB, 3 iterations and verifies correctly', async () => {
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 65536, timeCost: 3 });
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,/);
    expect(await verifyPassword(h, 'correct horse')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await hashPassword('correct horse')).not.toBe(h);
  });

  it('22.3 a malformed hash verifies as false instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('redaction', () => {
  it('15.4 exports the pino redact paths', () => {
    expect([...LOG_REDACT_PATHS]).toEqual([
      'authorization',
      'cookie',
      '*.token',
      '*.secret',
      '*.password',
      '*.accessToken',
      '*.refreshToken',
    ]);
  });

  it('15.4 scrub masks sensitive keys at any depth without mutating the input', () => {
    const input = {
      Authorization: 'Bearer abc',
      user: { name: 'a', password: 'p', nested: [{ access_token: 't', ok: 1 }] },
      cookie: 'c',
      refreshToken: 'r',
      when: new Date(0),
    };
    const out = scrub(input) as typeof input;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.user.password).toBe(REDACTED);
    expect(out.user.nested[0]).toEqual({ access_token: REDACTED, ok: 1 });
    expect(out.cookie).toBe(REDACTED);
    expect(out.refreshToken).toBe(REDACTED);
    expect(out.user.name).toBe('a');
    expect(out.when).toEqual(new Date(0));
    expect(input.user.password).toBe('p');
  });

  it('15.4 scrub survives cycles and primitives', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect((scrub(a) as Record<string, unknown>).self).toBe('[Circular]');
    expect(scrub('plain')).toBe('plain');
    expect(scrub(null)).toBeNull();
    const shared = { v: 1 };
    expect(scrub({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('15.4 redactSecrets masks bearer tokens and known values in text', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-1')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactSecrets('key=hunter22 and hunter22', ['hunter22', 'x'])).toBe(
      `key=${REDACTED} and ${REDACTED}`,
    );
  });
});

describe('internal request signing', () => {
  const parts = { ts: 1_700_000_000_000, method: 'post', path: '/internal/v1/x', body: '{"a":1}' };

  it('21.2 signs as v1=<hex> and exports header names', () => {
    const sig = signInternalRequest({ secret: 's', ...parts });
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(INTERNAL_TS_HEADER).toBe('X-Bastion-Ts');
    expect(INTERNAL_SIG_HEADER).toBe('X-Bastion-Sig');
    expect(signInternalRequest({ secret: 's', ...parts, method: 'POST' })).toBe(sig);
  });

  it('21.2 verifies within 30 s and rejects beyond', () => {
    const signature = signInternalRequest({ secret: 's', ...parts });
    const check = (now: number) => verifyInternalRequest({ ...parts, signature, secret: 's', now });
    expect(check(parts.ts).ok).toBe(true);
    expect(check(parts.ts + INTERNAL_MAX_SKEW_MS).ok).toBe(true);
    expect(check(parts.ts + INTERNAL_MAX_SKEW_MS + 1)).toEqual({ ok: false, reason: 'stale' });
    expect(check(parts.ts - INTERNAL_MAX_SKEW_MS - 1)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyInternalRequest({ ...parts, ts: Number.NaN, signature, secret: 's' })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('21.2 rejects any change to ts, method, path, body or secret', () => {
    const signature = signInternalRequest({ secret: 's', ...parts });
    const now = parts.ts;
    const bad = (over: Record<string, unknown>) =>
      verifyInternalRequest({ ...parts, signature, secret: 's', now, ...over });
    expect(bad({ method: 'GET' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(bad({ path: '/other' }).ok).toBe(false);
    expect(bad({ body: '{"a":2}' }).ok).toBe(false);
    expect(bad({ ts: parts.ts + 1 }).ok).toBe(false);
    expect(bad({ secret: 'other' }).ok).toBe(false);
    expect(bad({ signature: 'v1=short' }).ok).toBe(false);
  });

  it('22.3 accepts BASTION_INTERNAL_SECRET_PREVIOUS during rotation', () => {
    const signature = signInternalRequest({ secret: 'old', ...parts });
    const now = parts.ts;
    expect(
      verifyInternalRequest({ ...parts, signature, secret: 'new', previousSecret: 'old', now }).ok,
    ).toBe(true);
    expect(verifyInternalRequest({ ...parts, signature, secret: 'new', now }).ok).toBe(false);
    expect(
      verifyInternalRequest({
        ...parts,
        signature,
        secret: undefined,
        previousSecret: undefined,
        now,
      }),
    ).toEqual({ ok: false, reason: 'no_secret' });
  });
});
