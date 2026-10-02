/**
 * The only module that talks to the network. A thin wrapper over the generated `@bastion-mcp/api-client`:
 * CSRF double-submit (9.2), RFC 9457 problem+json mapped to `ApiError`, ETag / If-Match (17.1), cursor
 * pagination and a timeout on every call. Paths are checked against the OpenAPI document at compile time
 * (`ApiPath`), so a call to a route the API does not have is a type error.
 */
import { ApiProblemError, createApiClient, type PathsWith } from '@bastion-mcp/api-client';
import type { BodyOf, ItemOf, QueryOf, ResOf } from './schema';

export const API_BASE = '/api/v1';
export const CSRF_COOKIE = 'bastion_csrf';
export const CSRF_HEADER = 'x-bastion-csrf';
export const DEFAULT_TIMEOUT_MS = 30_000;

export type FieldError = { path: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly errors: FieldError[];
  readonly type: string | null;

  constructor(init: {
    status: number;
    code?: string;
    title?: string;
    detail?: string;
    errors?: FieldError[];
    type?: string | null;
  }) {
    const title = init.title ?? `Request failed (${init.status})`;
    super(init.detail ? `${title}: ${init.detail}` : title);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code ?? `http_${init.status}`;
    this.title = title;
    this.detail = init.detail ?? '';
    this.errors = init.errors ?? [];
    this.type = init.type ?? null;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isConflict(): boolean {
    return this.status === 412 || this.status === 409;
  }
}

type Fill<P extends string> = P extends `${infer A}{${string}}${infer B}`
  ? `${A}${string}${Fill<B>}`
  : P;
/** A concrete path (`/teams/abc`) of an operation with method `M` in the OpenAPI document. */
export type ApiPath<M extends 'get' | 'post' | 'put' | 'patch' | 'delete'> = Fill<
  Extract<PathsWith<M>, string>
>;

type Primitive = string | number | boolean | null | undefined;
export type Query = Record<string, Primitive | Primitive[]>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  /** Explicit If-Match value; defaults to the ETag remembered from the last GET of the same path. */
  etag?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type Hooks = { onUnauthorized: () => void };

const defaultLoginRedirect = (): void => {
  const back = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/auth/login?return_to=${encodeURIComponent(back)}`);
};

let hooks: Hooks = { onUnauthorized: defaultLoginRedirect };
export const configureApi = (next: Partial<Hooks>): void => {
  hooks = { ...hooks, ...next };
};

const etags = new Map<string, string>();
export const rememberEtag = (path: string, etag: string): void => {
  etags.set(path, etag);
};
export const clearEtags = (): void => etags.clear();

export const readCookie = (name: string, source: string = document.cookie): string | null => {
  for (const part of source.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
};

export const buildQuery = (query: Query | undefined): string => {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined && v !== null && v !== '') params.append(key, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
};

type Problem = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  errors?: { path?: string; pointer?: string; field?: string; message?: string; detail?: string }[];
};

export const parseProblem = async (res: Response): Promise<ApiError> => {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    try {
      const p = (await res.json()) as Problem;
      return new ApiError({
        status: p.status ?? res.status,
        ...(p.code ? { code: p.code } : {}),
        ...(p.title ? { title: p.title } : {}),
        ...(p.detail ? { detail: p.detail } : {}),
        ...(p.type ? { type: p.type } : {}),
        errors: (p.errors ?? []).map((e) => ({
          path: e.path ?? e.pointer ?? e.field ?? '',
          message: e.message ?? e.detail ?? 'Invalid value',
        })),
      });
    } catch {
      // fall through to the generic error
    }
  }
  return new ApiError({ status: res.status, title: res.statusText || undefined });
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type DynamicClient = Record<
  HttpMethod,
  (
    path: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
      ifMatch?: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    },
  ) => Promise<{ data: unknown; etag: string | undefined }>
>;

const generated = createApiClient({
  baseUrl: API_BASE,
  csrf: () => readCookie(CSRF_COOKIE) ?? undefined,
  // Late-bound so tests and MSW can replace the global fetch.
  fetch: (input, init) => globalThis.fetch(input, init),
}) as unknown as DynamicClient;

const cleanQuery = (query: Query | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    const list = (Array.isArray(value) ? value : [value]).filter(
      (v) => v !== undefined && v !== null && v !== '',
    );
    if (list.length > 0) out[key] = Array.isArray(value) ? list : list[0];
  }
  return out;
};

const fromProblem = (e: ApiProblemError): ApiError =>
  new ApiError({
    status: e.status,
    code: e.code,
    title: e.problem.title,
    detail: e.problem.detail,
    type: e.problem.type,
    errors: e.fieldErrors.map((f) => ({ path: f.path, message: f.message })),
  });

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const verb = method.toLowerCase() as HttpMethod;
  const ifMatch =
    MUTATING.has(method) && method !== 'POST' ? (options.etag ?? etags.get(path)) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    const res = await generated[verb](path, {
      query: cleanQuery(options.query),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(ifMatch ? { ifMatch } : {}),
      ...(MUTATING.has(method) && options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      signal: controller.signal,
    });
    if (res.etag) etags.set(path, res.etag);
    return res.data as T;
  } catch (e) {
    if (e instanceof ApiProblemError) {
      const err = fromProblem(e);
      if (err.isUnauthorized) hooks.onUnauthorized();
      throw err;
    }
    if (e instanceof ApiError) throw e;
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new ApiError({ status: 408, code: 'timeout', title: 'The request timed out' });
    }
    if (options.signal?.aborted) throw e;
    throw new ApiError({
      status: 0,
      code: 'network',
      title: 'Cannot reach Bastion',
      detail: e instanceof Error ? e.message : String(e),
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** The generated query type of an operation, loosened so callers may pass `null`/`undefined` for unset filters. */
export type LooseQuery<Q> = [Q] extends [never] ? undefined : { [K in keyof Q]?: Q[K] | null };

type Opts<M extends 'get' | 'post' | 'put' | 'patch' | 'delete', P extends string> = Omit<
  RequestOptions,
  'query' | 'body'
> & { query?: LooseQuery<QueryOf<M, P>> };

/**
 * The typed client: the path decides the request body, the query and the response type, all from the generated
 * OpenAPI types. A call to a route or a body that the API does not have is a compile error.
 */
export const api = {
  get: <P extends ApiPath<'get'>>(path: P, options?: Opts<'get', P>) =>
    request<ResOf<'get', P>>('GET', path, options as RequestOptions | undefined),
  post: <P extends ApiPath<'post'>>(path: P, body?: BodyOf<'post', P>, options?: Opts<'post', P>) =>
    request<ResOf<'post', P>>('POST', path, {
      ...(options as RequestOptions | undefined),
      ...(body !== undefined ? { body } : {}),
    }),
  put: <P extends ApiPath<'put'>>(path: P, body?: BodyOf<'put', P>, options?: Opts<'put', P>) =>
    request<ResOf<'put', P>>('PUT', path, {
      ...(options as RequestOptions | undefined),
      ...(body !== undefined ? { body } : {}),
    }),
  patch: <P extends ApiPath<'patch'>>(
    path: P,
    body?: BodyOf<'patch', P>,
    options?: Opts<'patch', P>,
  ) =>
    request<ResOf<'patch', P>>('PATCH', path, {
      ...(options as RequestOptions | undefined),
      ...(body !== undefined ? { body } : {}),
    }),
  delete: <P extends ApiPath<'delete'>>(path: P, options?: Opts<'delete', P>) =>
    request<ResOf<'delete', P>>('DELETE', path, options as RequestOptions | undefined),
};

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/** Follows `nextCursor` until exhausted (bounded by `maxPages`); items are typed by the operation's page. */
export async function fetchAll<P extends ApiPath<'get'>>(
  path: P,
  query?: LooseQuery<QueryOf<'get', P>>,
  maxPages = 20,
  signal?: AbortSignal,
): Promise<ItemOf<ResOf<'get', P>>[]> {
  const out: ItemOf<ResOf<'get', P>>[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: CursorPage<ItemOf<ResOf<'get', P>>> = (await request('GET', path, {
      query: { limit: 500, ...(query as Query | undefined), cursor },
      ...(signal ? { signal } : {}),
    })) as CursorPage<ItemOf<ResOf<'get', P>>>;
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/**
 * The pre-reconciliation client: the caller names the response type by hand. Only screens that have not moved to
 * the typed `api` above use it; it disappears with the last of them.
 */
export const legacyApi = {
  get: <T>(path: ApiPath<'get'>, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: ApiPath<'post'>, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  put: <T>(path: ApiPath<'put'>, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  patch: <T>(path: ApiPath<'patch'>, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  delete: <T = void>(path: ApiPath<'delete'>, options?: RequestOptions) =>
    request<T>('DELETE', path, options),
};

export async function legacyFetchAll<T>(
  path: ApiPath<'get'>,
  query: Query = {},
  maxPages = 20,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: CursorPage<T> = await legacyApi.get<CursorPage<T>>(path, {
      query: { limit: 500, ...query, cursor },
      ...(signal ? { signal } : {}),
    });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}
