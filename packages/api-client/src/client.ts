import { ApiProblemError, type Problem, problemFromBody } from './errors';
import type { paths } from './generated/schema';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type ApiPaths = paths;

type OpOf<P extends keyof paths, M extends HttpMethod> =
  paths[P] extends Record<M, infer O> ? O : never;

/** Paths that define operation `M`. */
export type PathsWith<M extends HttpMethod> = {
  [P in keyof paths]: paths[P] extends Record<M, infer O>
    ? [O] extends [never]
      ? never
      : P
    : never;
}[keyof paths];

type Part<O, K extends 'path' | 'query'> = O extends { parameters: infer Pm }
  ? K extends keyof Pm
    ? Exclude<Pm[K], undefined>
    : never
  : never;

type RequestBodyOf<O> = O extends { requestBody?: infer R } ? Exclude<R, undefined> : never;

type JsonBody<O> =
  RequestBodyOf<O> extends { content: { 'application/json': infer B } } ? B : never;

/** True when the operation declares a required request body. */
type BodyRequired<O> = O extends { requestBody: unknown } ? true : false;

type SuccessBody<O> = O extends { responses: infer R }
  ? {
      [S in keyof R & (200 | 201 | 202 | 204)]: R[S] extends {
        content: { 'application/json': infer B };
      }
        ? B
        : undefined;
    }[keyof R & (200 | 201 | 202 | 204)]
  : never;

type Optional<T, K extends string> = [T] extends [never]
  ? { [P in K]?: undefined }
  : { [P in K]: T };
type MaybeOptional<T, K extends string> = [T] extends [never]
  ? { [P in K]?: undefined }
  : { [P in K]?: T };

/** What a call accepts: path parameters, query, a JSON body and the 17.1 request headers. */
export type RequestOptions<O> = Optional<Part<O, 'path'>, 'path'> &
  MaybeOptional<Part<O, 'query'>, 'query'> &
  ([JsonBody<O>] extends [never]
    ? { body?: undefined }
    : BodyRequired<O> extends true
      ? { body: JsonBody<O> }
      : { body?: JsonBody<O> }) & {
    /** ETag of the resource version being changed (`If-Match`, 17.1). */
    ifMatch?: string;
    /** `Idempotency-Key` for POST (17.1). */
    idempotencyKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  };

export type ApiResponse<T> = {
  data: T;
  status: number;
  /** ETag of the returned resource, when the server sent one. */
  etag: string | undefined;
  headers: Headers;
};

export type ApiClientOptions = {
  /** `https://<host>/api/v1` or the origin; `/api/v1` is appended when missing. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** CSRF token for browser sessions (9.2); a function is re-read on every call. */
  csrf?: string | (() => string | undefined);
  /** PAT or OAuth access token; omit for cookie sessions. */
  token?: string | (() => string | undefined);
  headers?: Record<string, string>;
};

export const CSRF_HEADER = 'x-bastion-csrf';
const API_PREFIX = '/api/v1';

const normalizeBase = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith(API_PREFIX) ? trimmed : `${trimmed}${API_PREFIX}`;
};

const resolveValue = (v: string | (() => string | undefined) | undefined): string | undefined =>
  typeof v === 'function' ? v() : v;

const fill = (template: string, params: Record<string, unknown> | undefined): string =>
  template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw new TypeError(`missing path parameter ${name} for ${template}`);
    }
    return encodeURIComponent(String(value));
  });

const queryString = (query: Record<string, unknown> | undefined): string => {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) search.append(key, String(v));
    else search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

/** The strong ETag `"<updated_at>"` of a row, for `If-Match` (17.1). */
export const etagOf = (row: { updatedAt: string }): string => `"${row.updatedAt}"`;

type AnyOptions = {
  path?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  ifMatch?: string | undefined;
  idempotencyKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
};

export type ApiClient = {
  get<P extends PathsWith<'get'>>(
    path: P,
    options?: RequestOptions<OpOf<P, 'get'>>,
  ): Promise<ApiResponse<SuccessBody<OpOf<P, 'get'>>>>;
  post<P extends PathsWith<'post'>>(
    path: P,
    options?: RequestOptions<OpOf<P, 'post'>>,
  ): Promise<ApiResponse<SuccessBody<OpOf<P, 'post'>>>>;
  put<P extends PathsWith<'put'>>(
    path: P,
    options?: RequestOptions<OpOf<P, 'put'>>,
  ): Promise<ApiResponse<SuccessBody<OpOf<P, 'put'>>>>;
  patch<P extends PathsWith<'patch'>>(
    path: P,
    options?: RequestOptions<OpOf<P, 'patch'>>,
  ): Promise<ApiResponse<SuccessBody<OpOf<P, 'patch'>>>>;
  delete<P extends PathsWith<'delete'>>(
    path: P,
    options?: RequestOptions<OpOf<P, 'delete'>>,
  ): Promise<ApiResponse<SuccessBody<OpOf<P, 'delete'>>>>;
};

/**
 * Typed client over the generated OpenAPI types: `get/post/patch/put/delete`, the CSRF header for browser
 * sessions, `If-Match` and `Idempotency-Key` helpers, and `ApiProblemError` for RFC 9457 failures.
 */
export const createApiClient = (options: ApiClientOptions): ApiClient => {
  const base = normalizeBase(options.baseUrl);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const request = async (
    method: HttpMethod,
    template: string,
    opts: AnyOptions = {},
  ): Promise<ApiResponse<unknown>> => {
    const url = `${base}${fill(template, opts.path)}${queryString(opts.query)}`;
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    const token = resolveValue(options.token);
    if (token) headers.authorization = `Bearer ${token}`;
    if (method !== 'get') {
      const csrf = resolveValue(options.csrf);
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    if (opts.ifMatch !== undefined) headers['if-match'] = opts.ifMatch;
    if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    Object.assign(headers, opts.headers);
    const response = await doFetch(url, {
      method: method.toUpperCase(),
      headers,
      ...(body === undefined ? {} : { body }),
      credentials: 'same-origin',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const text = response.status === 204 ? '' : await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      throw new ApiProblemError(
        problemFromBody(response.status, parsed, text),
        response.headers.get('www-authenticate') ?? undefined,
      );
    }
    return {
      data: parsed,
      status: response.status,
      etag: response.headers.get('etag') ?? undefined,
      headers: response.headers,
    };
  };

  const call =
    (method: HttpMethod) =>
    (path: string, opts?: AnyOptions): Promise<ApiResponse<unknown>> =>
      request(method, path, opts);

  // The overloads above carry the types; the implementation only forwards.
  return {
    get: call('get'),
    post: call('post'),
    put: call('put'),
    patch: call('patch'),
    delete: call('delete'),
  } as unknown as ApiClient;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * Walks a paginated list (17.1): calls `fetchPage` with each `cursor` until `nextCursor` is null.
 * `for await (const item of paginate((cursor) => client.get('/users', { query: { cursor } })))`.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<ApiResponse<Page<T>>>,
  options: { maxPages?: number } = {},
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  const max = options.maxPages ?? Number.POSITIVE_INFINITY;
  for (let page = 0; page < max; page += 1) {
    const { data } = await fetchPage(cursor);
    for (const item of data.items) yield item;
    if (data.nextCursor === null) return;
    cursor = data.nextCursor;
  }
}

export type { Problem };
