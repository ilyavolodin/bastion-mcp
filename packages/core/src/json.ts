/** True for non-null, non-array objects. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns `obj` without keys whose value is `undefined`. */
export const omitUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A JSON value as an opaque base64url token (cursors). Same bytes as `Buffer.from(JSON.stringify(v))`. */
export const encodeJsonToken = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Inverse of `encodeJsonToken`; throws on a token that is not base64url JSON, so callers validate the result. */
export const decodeJsonToken = (token: string): unknown =>
  JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
