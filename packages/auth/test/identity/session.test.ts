import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertCsrf,
  CsrfError,
  checkCsrf,
  clearSessionCookies,
  csrfCookie,
  isStateChanging,
  parseCookies,
  SessionService,
  sessionCookie,
} from '../../src/identity';
import {
  FakeClock,
  MemoryPrincipals,
  MemoryRedis,
  MemoryRevocations,
  memberRecord,
} from './helpers';

const HOUR = 3_600_000;
const setup = () => {
  const clock = new FakeClock();
  const redis = new MemoryRedis(clock);
  const principals = new MemoryPrincipals();
  principals.records.set('u1', memberRecord('u1'));
  const revocations = new MemoryRevocations();
  const sessions = new SessionService({ redis, principals, revocations, clock });
  return { clock, redis, principals, revocations, sessions };
};

describe('9.2 browser sessions', () => {
  it('9.2 creates an opaque 32-byte id stored under uisess:{id} with a 12 h TTL', async () => {
    const { sessions, redis } = setup();
    const s = await sessions.create({ principalId: 'u1' });
    expect(Buffer.from(s.id, 'base64url')).toHaveLength(32);
    expect(redis.ttlMs(`uisess:${s.id}`)).toBe(12 * HOUR);
    expect(s.csrfToken).not.toBe(s.id);
  });

  it('9.2 validate slides the TTL back to 12 h', async () => {
    const { sessions, redis, clock } = setup();
    const s = await sessions.create({ principalId: 'u1' });
    clock.advance(10 * HOUR);
    expect(await sessions.validate(s.id)).toMatchObject({ principalId: 'u1' });
    expect(redis.ttlMs(`uisess:${s.id}`)).toBe(12 * HOUR);
  });

  it('9.2 expires after 12 h idle', async () => {
    const { sessions, clock } = setup();
    const s = await sessions.create({ principalId: 'u1' });
    clock.advance(12 * HOUR + 1);
    expect(await sessions.validate(s.id)).toBeNull();
  });

  it('9.2 enforces the 7-day absolute lifetime even when active', async () => {
    const { sessions, redis, clock } = setup();
    const s = await sessions.create({ principalId: 'u1' });
    for (let i = 0; i < 13; i++) {
      clock.advance(11 * HOUR);
      expect(await sessions.validate(s.id)).not.toBeNull();
    }
    expect(redis.ttlMs(`uisess:${s.id}`)).toBeLessThanOrEqual(12 * HOUR);
    clock.advance(7 * 24 * HOUR);
    expect(await sessions.validate(s.id)).toBeNull();
    expect(await redis.hgetall(`uisess:${s.id}`)).toEqual({});
  });

  it('9.2 the TTL never extends beyond the absolute deadline', async () => {
    const { sessions, redis, clock } = setup();
    const s = await sessions.create({ principalId: 'u1' });
    for (let i = 0; i < 15; i++) {
      clock.advance(11 * HOUR);
      await sessions.validate(s.id);
    }
    expect(redis.ttlMs(`uisess:${s.id}`)).toBe(3 * HOUR);
  });

  it('9.2 rejects malformed ids without touching Redis, and destroy removes the session', async () => {
    const { sessions } = setup();
    expect(await sessions.validate('short')).toBeNull();
    const s = await sessions.create({ principalId: 'u1' });
    await sessions.destroy(s.id);
    expect(await sessions.validate(s.id)).toBeNull();
  });

  it('9.2 authenticate returns a session principal with API scopes', async () => {
    const { sessions } = setup();
    const s = await sessions.create({ principalId: 'u1' });
    expect(await sessions.authenticate(s.id)).toMatchObject({
      id: 'u1',
      authMethod: 'session',
      scopes: ['api:read', 'api:write'],
    });
  });

  it('9.1 authenticate rejects deactivated principals and sessions older than the revocation watermark', async () => {
    const a = setup();
    const s = await a.sessions.create({ principalId: 'u1' });
    a.principals.records.set('u1', memberRecord('u1', { active: false }));
    expect(await a.sessions.authenticate(s.id)).toBeNull();

    const b = setup();
    const s2 = await b.sessions.create({ principalId: 'u1' });
    b.clock.advance(2000);
    b.revocations.watermarks.set('u1', b.clock.seconds);
    expect(await b.sessions.authenticate(s2.id)).toBeNull();
    b.clock.advance(1000);
    const s3 = await b.sessions.create({ principalId: 'u1' });
    b.clock.advance(2000);
    expect(await b.sessions.authenticate(s3.id)).not.toBeNull();
  });
});

describe('9.2 cookies and CSRF', () => {
  it('9.2 bastion_sid is HttpOnly, Secure, SameSite=Lax', () => {
    const c = sessionCookie('abc', 43_200);
    expect(c).toContain('bastion_sid=abc');
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) {
      expect(c).toContain(a);
    }
  });

  it('9.2 bastion_csrf is readable by the SPA (not HttpOnly) but Secure and Lax', () => {
    const c = csrfCookie('tok', 43_200);
    expect(c).toContain('bastion_csrf=tok');
    expect(c).not.toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
  });

  it('9.2 secure may only be disabled explicitly and clearing expires both cookies', () => {
    expect(sessionCookie('a', 1, { secure: false })).not.toContain('Secure');
    const cleared = clearSessionCookies();
    expect(cleared).toHaveLength(2);
    expect(cleared.every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('9.2 parses cookie headers', () => {
    expect(parseCookies('a=1; bastion_sid=xyz; b=c=d')).toEqual({
      a: '1',
      bastion_sid: 'xyz',
      b: 'c=d',
    });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('9.2 CSRF double submit: header must equal the cookie', () => {
    expect(checkCsrf('bastion_csrf=tok1', 'tok1')).toBe(true);
    expect(checkCsrf('bastion_csrf=tok1', 'tok2')).toBe(false);
    expect(checkCsrf('bastion_csrf=tok1', undefined)).toBe(false);
    expect(checkCsrf(undefined, 'tok1')).toBe(false);
    expect(checkCsrf('bastion_csrf=', '')).toBe(false);
    expect(() => assertCsrf('bastion_csrf=a', 'b')).toThrow(CsrfError);
    expect(() => assertCsrf('bastion_csrf=a', 'a')).not.toThrow();
  });

  it('9.2 property: CSRF passes iff header equals cookie', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/),
        (a, b) => {
          expect(checkCsrf(`bastion_csrf=${a}`, b)).toBe(a === b);
        },
      ),
    );
  });

  it('9.2 only state-changing methods require CSRF', () => {
    for (const m of ['POST', 'put', 'PATCH', 'DELETE']) expect(isStateChanging(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isStateChanging(m)).toBe(false);
  });
});
