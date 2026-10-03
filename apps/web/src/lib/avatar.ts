/**
 * The API has no icon for a catalog entry or installation (letter and colour were fixture fields), so screens derive
 * them from the name: the first letter, and one of the Zest tints picked by a stable hash of the slug. The same
 * entry looks the same everywhere, with no data from the server.
 */
export const TINTS = [
  'var(--sun)',
  'var(--berry)',
  'var(--sky)',
  'var(--teal)',
  'var(--tangerine)',
  'var(--mint)',
] as const;

/** A stable, non-negative 32-bit hash of a string. */
export const hashString = (value: string): number => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) >>> 0;
  return h;
};

/** The upper-case first letter or digit of a name (`?` when it has none). */
export const letterOf = (name: string): string =>
  (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();

/** A stable tint for a slug or id. */
export const tintOf = (key: string): string => TINTS[hashString(key) % TINTS.length] ?? TINTS[0];

/** Colours of the generic avatar of a person or a name (the initials chip). */
export const AVATAR_COLORS = [
  'var(--tangerine)',
  'var(--sky)',
  'var(--teal)',
  'var(--berry)',
  'var(--mint)',
  'var(--sun)',
] as const;

/** A stable avatar colour for an id or name. */
export const avatarColor = (seed: string): string =>
  AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
