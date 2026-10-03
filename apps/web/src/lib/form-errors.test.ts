import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldErrors, serverFieldErrors } from './form-errors';

describe('form errors', () => {
  it('fieldErrors keeps the first message per top-level field', () => {
    const schema = z.object({
      name: z.string().min(2, 'Too short').regex(/^a/, 'Must start with a'),
      tags: z.array(z.string().min(1, 'Empty tag')),
    });
    const parsed = schema.safeParse({ name: 'b', tags: [''] });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(fieldErrors(parsed.error)).toEqual({
        name: 'Too short',
        tags: 'Empty tag',
      });
  });

  it('serverFieldErrors keys by the first segment of the pointer, with or without a slash', () => {
    expect(
      serverFieldErrors([
        { path: '/slug', message: 'Taken' },
        { path: '/serverSpec/url', message: 'Bad url' },
        { path: 'name', message: 'Required' },
        { path: '', message: 'Whole body' },
      ]),
    ).toEqual({ slug: 'Taken', serverSpec: 'Bad url', name: 'Required', '': 'Whole body' });
  });
});
