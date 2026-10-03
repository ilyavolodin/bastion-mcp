import { decodeJsonToken, encodeJsonToken } from '@bastion-mcp/core';
import { z } from 'zod';
import { PreconditionFailedError, PreconditionRequiredError } from '../errors';
import type { ListQuery, Page } from '../ports/store';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** 17.1 pagination, text search and sorting; extend it with route-specific filters. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
  q: z.string().min(1).max(200).optional(),
  sort: z
    .string()
    .regex(/^-?[A-Za-z][A-Za-z0-9_]{0,63}$/, 'use field or -field')
    .optional(),
});
export type ListQueryInput = z.output<typeof listQuerySchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const parseSort = (sort: string | undefined): ListQuery['sort'] => {
  if (!sort) return undefined;
  return sort.startsWith('-') ? { field: sort.slice(1), desc: true } : { field: sort, desc: false };
};

export const toListQuery = (query: ListQueryInput, where?: Record<string, unknown>): ListQuery => ({
  limit: query.limit,
  cursor: query.cursor,
  q: query.q,
  sort: parseSort(query.sort),
  where,
});

/** Applies `?limit` and a cursor to an already materialized list (offset cursors). */
export const pageOfArray = <T>(
  items: readonly T[],
  query: { limit: number; cursor?: string | undefined },
): Page<T> => {
  const offset = decodeOffset(query.cursor);
  const slice = items.slice(offset, offset + query.limit);
  const next = offset + query.limit;
  return { items: slice, nextCursor: next < items.length ? encodeOffset(next) : null };
};

export const encodeOffset = (offset: number): string => encodeJsonToken({ o: offset });

export const decodeOffset = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const parsed = z.object({ o: z.number().int().min(0) }).parse(decodeJsonToken(cursor));
    return parsed.o;
  } catch {
    return 0;
  }
};

/** Strong ETag of a resource version (`updated_at`). */
export const etagOf = (version: string): string => `"${version}"`;

const stripTag = (tag: string): string => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/**
 * 17.1 concurrency: `If-Match` is required once the resource exists (428 when missing), and must name its
 * current version (412 otherwise). A resource that does not exist yet needs no precondition.
 */
export const checkPrecondition = (current: string | null, ifMatch: string | undefined): void => {
  if (current === null) return;
  if (ifMatch === undefined || ifMatch.trim() === '') throw new PreconditionRequiredError();
  if (ifMatch.trim() === '*') return;
  const tags = ifMatch.split(',').map(stripTag);
  if (!tags.includes(current)) throw new PreconditionFailedError();
};
