import { sha256Hex } from './canonical';

export { sha256Hex };

export const MAX_NAME_LENGTH = 128;
export const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const NAME_SEPARATOR = '__';

export type PrefixMode = 'always' | 'onCollision';

/** Characters outside [A-Za-z0-9_.-] become `_` (7.3). */
export const sanitizeNamePart = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Cuts `safe` to `budget` chars, ending with `_` + 6 hex of the original's SHA-256 (7.3). */
const cutWithHash = (safe: string, original: string, budget: number): string => {
  if (safe.length <= budget) return safe;
  const suffix = `_${sha256Hex(original).slice(0, 6)}`;
  return `${safe.slice(0, Math.max(budget - suffix.length, 0))}${suffix}`;
};

/** `{prefix}__{upstreamName}`, sanitized and length-limited (7.3). */
export const finalName = (prefix: string, upstreamName: string): string => {
  const head = `${sanitizeNamePart(prefix)}${NAME_SEPARATOR}`;
  const upstream = cutWithHash(
    sanitizeNamePart(upstreamName),
    upstreamName,
    Math.max(MAX_NAME_LENGTH - head.length, 0),
  );
  return `${head}${upstream}`.slice(0, MAX_NAME_LENGTH);
};

export type NameCandidate = {
  key: string;
  installationId: string;
  /** Lower number = higher priority (endpoint order). */
  priority: number;
  prefix: string;
  upstreamName: string;
  /** An override that sets the exact final name (12.3). */
  exactName?: string;
};

export type ResolvedName = { key: string; name: string; collided: boolean };

const withSuffix = (name: string, n: number): string => {
  const suffix = `_${n}`;
  return `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
};

/**
 * Resolves final names for a merged endpoint (7.3). The item from the higher-priority installation
 * keeps a contested name; the others get `_2`, `_3`. In `onCollision` mode only contested
 * un-overridden names are prefixed. Output order equals input order.
 */
export const resolveNames = (
  candidates: readonly NameCandidate[],
  mode: PrefixMode,
): ResolvedName[] => {
  const bare = (c: NameCandidate): string => {
    const source = c.exactName ?? c.upstreamName;
    return cutWithHash(sanitizeNamePart(source), source, MAX_NAME_LENGTH);
  };
  const prefixed = (c: NameCandidate): string =>
    c.exactName !== undefined ? bare(c) : finalName(c.prefix, c.upstreamName);

  const initial = candidates.map((c) => (mode === 'always' ? prefixed(c) : bare(c)));
  const bareCounts = new Map<string, number>();
  for (const name of initial) bareCounts.set(name, (bareCounts.get(name) ?? 0) + 1);

  const wanted = candidates.map((c, i) => {
    const name = initial[i] as string;
    return mode === 'onCollision' && (bareCounts.get(name) ?? 0) > 1 && c.exactName === undefined
      ? prefixed(c)
      : name;
  });

  const order = candidates
    .map((_, i) => i)
    .sort(
      (a, b) =>
        (candidates[a] as NameCandidate).priority - (candidates[b] as NameCandidate).priority ||
        a - b,
    );

  const taken = new Set<string>();
  const result: ResolvedName[] = new Array(candidates.length);
  for (const i of order) {
    const base = wanted[i] as string;
    let name = base;
    let n = 1;
    while (taken.has(name)) {
      n += 1;
      name = withSuffix(base, n);
    }
    taken.add(name);
    result[i] = { key: (candidates[i] as NameCandidate).key, name, collided: n > 1 };
  }
  return result;
};
