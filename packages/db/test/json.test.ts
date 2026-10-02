import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJson, writeJson } from '../src/json';

describe('16.1 JSONB columns are validated by zod on write and on read', () => {
  const schema = z.object({ a: z.number(), b: z.string().default('x') });

  it('parses and applies defaults in both directions', () => {
    expect(writeJson(schema, { a: 1 })).toEqual({ a: 1, b: 'x' });
    expect(readJson(schema, { a: 2, b: 'y' })).toEqual({ a: 2, b: 'y' });
  });

  it('rejects documents that do not match', () => {
    expect(() => readJson(schema, { a: 'nope' })).toThrow();
    expect(() => writeJson(schema, { a: 'nope' } as never)).toThrow();
  });
});
