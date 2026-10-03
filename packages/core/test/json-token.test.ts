import { describe, expect, it } from 'vitest';
import { decodeJsonToken, decodeListCursor, encodeJsonToken, encodeListCursor } from '../src';

describe('7.5 JSON tokens', () => {
  it('7.5 round-trips any JSON value', () => {
    for (const value of [{ o: 3 }, [1, 'a', null], 'text', 0, null, { nested: { ok: true } }]) {
      expect(decodeJsonToken(encodeJsonToken(value))).toEqual(value);
    }
  });

  it('7.5 produces URL-safe base64 of the compact JSON (the cursor wire format)', () => {
    expect(encodeJsonToken({ o: 50 })).toBe(Buffer.from('{"o":50}').toString('base64url'));
    expect(encodeJsonToken({ o: 50 })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('7.5 throws on a token that is not JSON, so callers must validate', () => {
    expect(() => decodeJsonToken('!!not-base64-json!!')).toThrow();
    expect(() => decodeJsonToken('')).toThrow();
  });

  it('7.5 list cursors keep their documented format on top of it', () => {
    const cursor = encodeListCursor({ offset: 20, endpointHash: 'h1' });
    expect(cursor).toBe(
      `bcur1.${Buffer.from('{"offset":20,"endpointHash":"h1"}').toString('base64url')}`,
    );
    expect(decodeListCursor(cursor, 'h1')).toBe(20);
    expect(decodeListCursor(cursor, 'other')).toBe(0);
    expect(decodeListCursor('bcur1.%%%', 'h1')).toBe(0);
  });
});
