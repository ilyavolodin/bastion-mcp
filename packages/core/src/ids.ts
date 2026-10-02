import { uuidv7 } from 'uuidv7';

/** UUIDv7 (time-sortable), generated in the application (2). `unixTsMs` exists for deterministic tests. */
export const newId = (unixTsMs?: number): string => {
  if (unixTsMs === undefined) return uuidv7();
  // The package has no timestamp parameter; build from its generator for a fixed instant.
  const base = uuidv7().replace(/-/g, '');
  const ts = unixTsMs.toString(16).padStart(12, '0');
  const hex = `${ts}${base.slice(12)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;
const MARKETPLACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Human-facing identifiers: lowercase [a-z0-9-], 2 to 40 characters (2). */
export const isValidSlug = (value: string): boolean => SLUG_PATTERN.test(value);

/** Marketplace slugs are manifest names (25.4). */
export const isValidMarketplaceSlug = (value: string): boolean =>
  MARKETPLACE_SLUG_PATTERN.test(value);

/** Lowercases, strips accents, collapses runs of other characters into one `-`, trims dashes. */
export const slugify = (value: string, maxLength = 40): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

/** A team installation's effective slug (7.1). */
export const effectiveTeamSlug = (teamSlug: string, slug: string): string => `${teamSlug}-${slug}`;

/** Default tool prefix: the installation slug with `-` replaced by `_` (7.3). */
export const toolPrefixFromSlug = (slug: string): string => slug.replace(/-/g, '_');
