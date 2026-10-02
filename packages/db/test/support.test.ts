import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/client';
import {
  afterIdAsc,
  afterIdDesc,
  afterStringAsc,
  assertIfMatch,
  assertSwapped,
  bytesToHex,
  clampLimit,
  decodeCursor,
  encodeCursor,
  etagOf,
  hexToBytes,
  InvalidCursorError,
  isUniqueViolation,
  nextUpdatedAt,
  orConflict,
  PreconditionFailedError,
  PreconditionRequiredError,
  toContext,
  toPage,
  UnitState,
} from '../src/repositories/support';

const row = (updatedAt: number | null) => ({
  createdAt: new Date(1_000_000),
  updatedAt: updatedAt === null ? null : new Date(updatedAt),
});

describe('17.1 ETag and If-Match', () => {
  it('derives the ETag from updated_at, falling back to created_at', () => {
    expect(etagOf(row(null))).toBe(`"${(1_000_000).toString(36)}"`);
    expect(etagOf(row(2_000_000))).not.toBe(etagOf(row(null)));
  });

  it.each([
    ['exact', undefined, true],
    ['weak prefix', 'W/', true],
    ['wildcard', '*', true],
    ['list containing it', 'x, ', true],
  ])('accepts %s', (_name, prefix, ok) => {
    const r = row(5_000);
    const tag = etagOf(r);
    const header =
      prefix === '*' ? '*' : prefix === 'x, ' ? `"zzz", ${tag}` : `${prefix ?? ''}${tag}`;
    expect(() => assertIfMatch(r, header)).not.toThrow();
    expect(ok).toBe(true);
  });

  it('17.1 answers 412 when the ETag differs and 428 when the header is missing', () => {
    const r = row(5_000);
    expect(() => assertIfMatch(r, '"stale"')).toThrow(PreconditionFailedError);
    expect(() => assertIfMatch(r, undefined)).toThrow(PreconditionRequiredError);
    expect(() => assertIfMatch(r, '  ')).toThrow(PreconditionRequiredError);
    try {
      assertIfMatch(r, '"stale"');
    } catch (e) {
      expect(e).toMatchObject({ httpStatus: 412, code: 'PRECONDITION_FAILED' });
    }
  });

  it('assertSwapped treats a lost compare-and-swap as 412', () => {
    expect(() => assertSwapped({ count: 1 })).not.toThrow();
    expect(() => assertSwapped({ count: 0 })).toThrow(PreconditionFailedError);
  });

  it('nextUpdatedAt is strictly after the current version', () => {
    const r = row(10_000);
    expect(nextUpdatedAt(r, new Date(1)).getTime()).toBe(10_001);
    expect(nextUpdatedAt(r, new Date(99_999)).getTime()).toBe(99_999);
  });
});

describe('17.1 keyset pagination cursors', () => {
  it('round-trips opaque cursors and rejects garbage', () => {
    const c = encodeCursor([1234, 'abc']);
    expect(c).not.toContain('abc');
    expect(decodeCursor(c)).toEqual([1234, 'abc']);
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
    expect(() => decodeCursor('!!!')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });

  it('clamps limits to 1..500 with a default of 50', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10_000)).toBe(500);
    expect(clampLimit(7.9)).toBe(7);
  });

  it('cuts a limit+1 fetch into a page with a next cursor', () => {
    const rows = [1, 2, 3];
    expect(toPage(rows, 3, (n) => [n])).toEqual({ items: [1, 2, 3], nextCursor: null });
    const page = toPage(rows, 2, (n) => [n]);
    expect(page.items).toEqual([1, 2]);
    expect(decodeCursor(page.nextCursor ?? '')).toEqual([2]);
  });

  it('builds keyset conditions for id and string orders', () => {
    const cursor = encodeCursor(['id1']);
    expect(afterIdDesc(cursor)).toEqual({ id: { lt: 'id1' } });
    expect(afterIdAsc(cursor)).toEqual({ id: { gt: 'id1' } });
    expect(afterIdDesc(undefined)).toEqual({});
    expect(afterIdAsc(undefined)).toEqual({});
    expect(afterStringAsc('slug', encodeCursor(['b']))).toEqual({ slug: { gt: 'b' } });
    expect(afterStringAsc('slug', undefined)).toEqual({});
    expect(() => afterStringAsc('slug', encodeCursor([5]))).toThrow(InvalidCursorError);
    expect(() => afterIdDesc(encodeCursor([5]))).toThrow(InvalidCursorError);
    expect(() => afterIdAsc(encodeCursor([5]))).toThrow(InvalidCursorError);
  });
});

describe('16.1 helpers', () => {
  it('converts hex and bytes both ways', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
  });

  it('detects unique violations', async () => {
    const unique = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    expect(isUniqueViolation(unique)).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    await expect(orConflict('thing', () => Promise.reject(unique))).rejects.toMatchObject({
      httpStatus: 409,
    });
    await expect(orConflict('thing', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(orConflict('thing', () => Promise.resolve(5))).resolves.toBe(5);
  });

  it('4.3 records config bumps once per scope and id and audits only with a context', () => {
    const unit = new UnitState();
    unit.bump('team', 'a');
    unit.bump('team', 'a');
    unit.bump('org');
    expect(unit.bumps.size).toBe(2);
    unit.audit(undefined, { action: 'x', targetType: 't' });
    expect(unit.audits).toHaveLength(0);
    unit.audit({ actorType: 'user' }, { action: 'x', targetType: 't' });
    expect(unit.audits).toHaveLength(1);
  });

  it('toContext distinguishes a database handle from a context', () => {
    const fake = { $queryRaw: () => 0 } as never;
    expect(toContext(fake).db).toBe(fake);
    const ctx = toContext({ db: fake, publishConfig: () => {} } as never);
    expect(ctx.db).toBe(fake);
  });
});
