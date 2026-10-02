import { PolicyGenerationError } from './errors';

const SIMPLE_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
};

/** Cedar string body (without quotes): escapes quotes, backslashes and control characters (10.3). */
export const escapeCedarString = (value: string): string => {
  let out = '';
  for (const ch of value) {
    const simple = SIMPLE_ESCAPES[ch];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) {
      out += '�'; // a lone surrogate cannot be encoded in Cedar text
      continue;
    }
    out += code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : ch;
  }
  return out;
};

/** A quoted, escaped Cedar string literal. */
export const cedarString = (value: string): string => `"${escapeCedarString(value)}"`;

/**
 * A Cedar `like` pattern from a glob. Only `*` is a wildcard; every other character is literal.
 * `?`, `[` and `{` are rejected rather than silently treated as literals.
 */
export const globToCedarLike = (glob: string): string => {
  if (/[?[\]{}]/.test(glob)) {
    throw new PolicyGenerationError('Tool name globs support only the * wildcard', { glob });
  }
  return `"${glob.split('*').map(escapeCedarString).join('*')}"`;
};

export const isGlob = (value: string): boolean => value.includes('*');

/** Identifiers that end up inside `@id("...")` must not need escaping. */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const assertSafeId = (id: string, what: string): string => {
  if (!SAFE_ID.test(id)) throw new PolicyGenerationError(`Unsafe ${what}`, { id });
  return id;
};
