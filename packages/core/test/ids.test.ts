import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  effectiveTeamSlug,
  isValidMarketplaceSlug,
  isValidSlug,
  newId,
  slugify,
  toolPrefixFromSlug,
} from '../src/ids';

describe('2 conventions: ids and slugs', () => {
  it('generates UUIDv7 ids that sort by creation time', () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_001_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('accepts slugs of 2 to 40 chars of [a-z0-9-]', () => {
    expect(isValidSlug('github')).toBe(true);
    expect(isValidSlug('a-b')).toBe(true);
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('A-b')).toBe(false);
    expect(isValidSlug('a_b')).toBe(false);
    expect(isValidSlug('a'.repeat(41))).toBe(false);
    expect(isValidSlug('a'.repeat(40))).toBe(true);
  });

  it('slugify output is always a valid slug when the input has an alphanumeric', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /[a-z0-9]{2}/i.test(s.normalize('NFKD'))),
        (s) => {
          const slug = slugify(s);
          return slug === '' || isValidSlug(slug);
        },
      ),
    );
    expect(slugify('Postgres Analytics!')).toBe('postgres-analytics');
    expect(slugify('  --Hello__World--  ')).toBe('hello-world');
  });

  it('7.1 team installation effective slug is {teamSlug}-{slug}', () => {
    expect(effectiveTeamSlug('data', 'pg')).toBe('data-pg');
  });

  it('7.3 default tool prefix replaces - with _', () => {
    expect(toolPrefixFromSlug('my-server')).toBe('my_server');
  });

  it('25.4 marketplace slugs match ^[a-z0-9][a-z0-9-]{1,62}$', () => {
    expect(isValidMarketplaceSlug('acme-eng')).toBe(true);
    expect(isValidMarketplaceSlug('-acme')).toBe(false);
    expect(isValidMarketplaceSlug('a')).toBe(false);
    expect(isValidMarketplaceSlug('a'.repeat(64))).toBe(false);
  });
});
