/**
 * Helpers for the MSW mock of the control-plane API. Handlers written with `route` are typed by the generated
 * OpenAPI types: the response a handler returns must be the operation's response, and the request body it reads is
 * the operation's request body, so a handler or a fixture that drifts from the API is a compile error (and
 * `src/test/contract.ts` validates the same bodies against the JSON schemas at test time).
 */
import {
  type DefaultBodyType,
  delay,
  type HttpHandler,
  HttpResponse,
  http,
  type StrictResponse,
} from 'msw';
import type { Body, Method, PathKey, Query, Res } from '@/api/schema';
import { type Action, can } from './roles';

export const P = (path: string) => `*/api/v1${path}`;
export const latency = () => (import.meta.env.MODE === 'test' ? Promise.resolve() : delay(90));

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: { path: string; message: string }[];
};

export const problem = (
  status: number,
  code: string,
  title: string,
  detail?: string,
  errors?: { path: string; message: string }[],
): StrictResponse<ProblemBody> =>
  HttpResponse.json(
    {
      type: `https://bastion-mcp.github.io/errors/${code}`,
      title,
      status,
      code,
      detail: detail ?? title,
      ...(errors ? { errors } : {}),
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

export const forbidden = () =>
  problem(403, 'forbidden', 'You do not have access to this', 'Ask an admin to change your role.');
export const notFound = (what = 'Resource') => problem(404, 'not_found', `${what} not found`);

/** The API's page size rules (`listQuerySchema` in `packages/api`; the OpenAPI `limit` parameter). */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** Cursors are opaque, like the API's (base64url of JSON): a screen cannot parse or build one. */
export const encodeCursor = (offset: number): string =>
  btoa(JSON.stringify({ o: offset }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
export const decodeCursor = (cursor: string | null): number => {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as { o?: unknown }).o;
    return typeof o === 'number' && Number.isInteger(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
};

/** Cursor pagination over an in-memory list: `?limit` (1 to 500, default 50) and an opaque `?cursor`. */
export const pageOf = <T>(
  items: readonly T[],
  url: URL,
  defaultLimit = DEFAULT_LIMIT,
): { items: T[]; nextCursor: string | null } => {
  const asked = Number(url.searchParams.get('limit') ?? defaultLimit);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(asked) || defaultLimit));
  const offset = decodeCursor(url.searchParams.get('cursor'));
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: slice, nextCursor: next };
};

/**
 * `If-Match` is required on a change and must name the row's current version (17.1): 428 without it, 412 when it
 * names another version. `*` matches any. Returns null when the change may go on.
 */
export const checkVersion = (request: Request, row: { updatedAt: string }) => {
  const given = request.headers.get('if-match');
  if (!given) return problem(428, 'precondition_required', 'If-Match is required');
  const tags = given.split(',').map((t) => t.trim().replace(/^W\//, '').replace(/"/g, ''));
  if (tags.includes('*') || tags.includes(row.updatedAt)) return null;
  return problem(412, 'precondition_failed', 'The resource was modified; reload and retry');
};

/** CSRF double-submit on every state-changing call (9.2). */
export const csrfMiddleware = http.all(P('/*'), ({ request }) => {
  if (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
    !request.headers.get('x-bastion-csrf')
  ) {
    return problem(403, 'csrf_missing', 'Missing CSRF token', 'Reload the page and try again.');
  }
  return undefined;
});

/** Row version header: the API sends the row's `updatedAt` as its ETag (17.1). */
export const etagHeaders = (version: string) => ({ ETag: `"${version}"` });

type ParamNames<K extends string> = K extends `${string}{${infer N}}${infer Rest}`
  ? N | ParamNames<Rest>
  : never;
export type RouteParams<K extends string> = { [N in ParamNames<K>]: string };

/** What a handler may answer: the operation's typed response, or a problem. */
export type Answer<T> =
  | StrictResponse<(T extends DefaultBodyType ? T : never) | ProblemBody>
  | StrictResponse<ProblemBody>
  | (T extends undefined | null ? Response : never);

export type RouteInfo<M extends Method, K extends PathKey<M>> = {
  request: Request;
  /**
   * A change that creates its row (a first save, a new member) has no version to name: the handler calls this to
   * say so, and the test setup then does not count the missing `If-Match` as a screen's mistake (17.1).
   */
  waiveVersion: () => void;
  url: URL;
  params: RouteParams<K>;
  /** The typed JSON body of the request (only for operations that take one). */
  body: () => Promise<Body<M, K>>;
  query: Query<M, K>;
};

const waivedVersions = new Set<string>();
const changesAnswered = new Set<string>();
/** Whether a typed handler of this mock answered the change (a test may put its own handler in front of it). */
export const changeAnswered = (requestId: string): boolean => changesAnswered.has(requestId);
/** Whether the handler of this request waived the `If-Match` precondition (see `RouteInfo.waiveVersion`). */
export const versionWaived = (requestId: string): boolean => waivedVersions.has(requestId);

const toMsw = (key: string) => P(key.replace(/\{path\}/g, '*').replace(/\{(\w+)\}/g, ':$1'));

/** Every operation a typed handler answers, for the coverage check of `route-contract.test.ts`. */
export const typedRoutes: { method: Method; key: string }[] = [];

/** One valid call of an operation, used to check that the mock answers what the OpenAPI document says. */
export type Sample = { method: Method; path: string; body?: unknown };
/** A domain's samples, built from the seeded db (ids of real rows go in the paths and bodies). */
export type SampleFactory = (db: import('./db').MockDb) => Sample[];

/** `allow`: the role action that may call a route; anybody else gets the 403 before the handler runs. */
export type RouteOptions = { allow?: Action };

const make =
  <M extends Method>(method: M) =>
  <K extends PathKey<M>>(
    key: K,
    resolve: (info: RouteInfo<M, K>) => Answer<Res<M, K>> | Promise<Answer<Res<M, K>>>,
    options: RouteOptions = {},
  ): HttpHandler => {
    typedRoutes.push({ method, key });
    return http[method](toMsw(key), (info) => {
      if (method !== 'get' && method !== 'post') changesAnswered.add(info.requestId);
      if (options.allow && !can(options.allow)) return forbidden() as never;
      const url = new URL(info.request.url);
      return resolve({
        request: info.request,
        waiveVersion: () => void waivedVersions.add(info.requestId),
        url,
        params: info.params as RouteParams<K>,
        body: () => info.request.clone().json() as Promise<Body<M, K>>,
        query: Object.fromEntries(url.searchParams) as unknown as Query<M, K>,
      }) as never;
    });
  };

/**
 * `route.get('/teams/{id}', ({ params }) => HttpResponse.json(row))`: the path is an operation of the OpenAPI
 * document (`{id}` for path parameters), so a mock-only route does not compile.
 */
export const route = {
  get: make('get'),
  post: make('post'),
  put: make('put'),
  patch: make('patch'),
  delete: make('delete'),
};

/** A 204 answer. */
export const noContent = () => new HttpResponse(null, { status: 204 });
export { HttpResponse };
