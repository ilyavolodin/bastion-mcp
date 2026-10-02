import { describe, expect, it } from 'vitest';
import { letterOf, TINTS, tintOf } from './avatar';

describe('avatar helpers', () => {
  it('takes the first letter of a name', () => {
    expect(letterOf('Postgres analytics')).toBe('P');
    expect(letterOf('  (beta) tool')).toBe('B');
    expect(letterOf('---')).toBe('?');
  });

  it('picks a stable Zest tint per key', () => {
    expect(tintOf('github')).toBe(tintOf('github'));
    expect(TINTS).toContain(tintOf('anything'));
  });
});
