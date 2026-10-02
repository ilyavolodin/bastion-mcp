import { describe, expect, it } from 'vitest';
import { decodeListCursor, encodeListCursor, paginate } from '../src/cursor';

describe('7.5 list cursors', () => {
  it('encodes as bcur1. + base64url(JSON)', () => {
    const c = encodeListCursor({ offset: 10, endpointHash: 'abc' });
    expect(c.startsWith('bcur1.')).toBe(true);
    expect(decodeListCursor(c, 'abc')).toBe(10);
  });

  it('a cursor from an older endpoint hash restarts at offset 0', () => {
    const c = encodeListCursor({ offset: 10, endpointHash: 'old' });
    expect(decodeListCursor(c, 'new')).toBe(0);
  });

  it('malformed cursors restart at 0', () => {
    expect(decodeListCursor('garbage', 'x')).toBe(0);
    expect(decodeListCursor('bcur1.!!!', 'x')).toBe(0);
    expect(decodeListCursor(undefined, 'x')).toBe(0);
  });

  it('paginates and returns a next cursor until the last page', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const p1 = paginate(items, { pageSize: 2, endpointHash: 'h' });
    expect(p1.items).toEqual([0, 1]);
    const p2 = paginate(items, { pageSize: 2, endpointHash: 'h', cursor: p1.nextCursor });
    expect(p2.items).toEqual([2, 3]);
    const p3 = paginate(items, { pageSize: 2, endpointHash: 'h', cursor: p2.nextCursor });
    expect(p3.items).toEqual([4]);
    expect(p3.nextCursor).toBeUndefined();
  });
});
