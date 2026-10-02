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

/** Offset cursor pagination over an in-memory list (`nextCursor` is the next offset). */
export const pageOf = <T>(
  items: readonly T[],
  url: URL,
): { items: T[]; nextCursor: string | null } => {
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50);
  const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { items: slice, nextCursor: next };
};

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
  | (T extends undefined | null | void ? Response : never);

export type RouteInfo<M extends Method, K extends PathKey<M>> = {
  request: Request;
  url: URL;
  params: RouteParams<K>;
  /** The typed JSON body of the request (only for operations that take one). */
  body: () => Promise<Body<M, K>>;
  query: Query<M, K>;
};

const toMsw = (key: string) => P(key.replace(/\{path\}/g, '*').replace(/\{(\w+)\}/g, ':$1'));

/** Every operation a typed handler answers, for the coverage check of `route-contract.test.ts`. */
export const typedRoutes: { method: Method; key: string }[] = [];

/** One valid call of an operation, used to check that the mock answers what the OpenAPI document says. */
export type Sample = { method: Method; path: string; body?: unknown };
/** A domain's samples, built from the seeded db (ids of real rows go in the paths and bodies). */
export type SampleFactory = (db: import('./db').MockDb) => Sample[];

const make =
  <M extends Method>(method: M) =>
  <K extends PathKey<M>>(
    key: K,
    resolve: (info: RouteInfo<M, K>) => Answer<Res<M, K>> | Promise<Answer<Res<M, K>>>,
  ): HttpHandler => (
    typedRoutes.push({ method, key }),
    http[method](toMsw(key), (info) => {
      const url = new URL(info.request.url);
      return resolve({
        request: info.request,
        url,
        params: info.params as RouteParams<K>,
        body: () => info.request.clone().json() as Promise<Body<M, K>>,
        query: Object.fromEntries(url.searchParams) as unknown as Query<M, K>,
      }) as never;
    })
  );

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
