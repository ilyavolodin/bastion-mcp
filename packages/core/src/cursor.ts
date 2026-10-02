import { TOKEN_PREFIXES } from './constants';

type CursorPayload = { offset: number; endpointHash: string };

/** `bcur1.` + base64url({offset, endpointHash}) (7.5). */
export const encodeListCursor = (payload: CursorPayload): string =>
  `${TOKEN_PREFIXES.listCursor}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

/** Returns the offset to resume at; a malformed cursor or one from an older endpoint hash restarts at 0. */
export const decodeListCursor = (cursor: string | undefined, endpointHash: string): number => {
  if (!cursor?.startsWith(TOKEN_PREFIXES.listCursor)) return 0;
  try {
    const raw = Buffer.from(cursor.slice(TOKEN_PREFIXES.listCursor.length), 'base64url').toString(
      'utf8',
    );
    const parsed = JSON.parse(raw) as Partial<CursorPayload>;
    const valid =
      parsed.endpointHash === endpointHash &&
      Number.isInteger(parsed.offset) &&
      (parsed.offset as number) >= 0;
    return valid ? (parsed.offset as number) : 0;
  } catch {
    return 0;
  }
};

export type Page<T> = { items: T[]; nextCursor?: string };

/** Serves one page of a fully merged list (7.5). */
export const paginate = <T>(
  items: readonly T[],
  options: { pageSize: number; endpointHash: string; cursor?: string | undefined },
): Page<T> => {
  const offset = decodeListCursor(options.cursor, options.endpointHash);
  const end = offset + options.pageSize;
  const page: Page<T> = { items: items.slice(offset, end) };
  if (end < items.length) {
    page.nextCursor = encodeListCursor({ offset: end, endpointHash: options.endpointHash });
  }
  return page;
};
