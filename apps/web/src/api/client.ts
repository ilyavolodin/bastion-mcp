/**
 * The only module that talks to the network. A thin typed fetch wrapper: CSRF double-submit (9.2),
 * RFC 9457 problem+json errors, ETag / If-Match (17.1), cursor pagination and a timeout on every call.
 * Swapping to the generated `@bastion-mcp/api-client` means re-implementing `request` here.
 */
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

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (MUTATING.has(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
    if (method !== 'POST') {
      const etag = options.etag ?? etags.get(path);
      if (etag) headers['If-Match'] = etag;
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${API_BASE}${path}${buildQuery(options.query)}`, {
      method,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!res.ok) {
      const err = await parseProblem(res);
      if (err.isUnauthorized) hooks.onUnauthorized();
      throw err;
    }
    const etag = res.headers.get('etag');
    if (etag) etags.set(path, etag);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (e) {
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

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  delete: <T = void>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
};

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/** Follows `nextCursor` until exhausted (bounded by `maxPages`). */
export async function fetchAll<T>(
  path: string,
  query: Query = {},
  maxPages = 20,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: CursorPage<T> = await api.get<CursorPage<T>>(path, {
      query: { limit: 500, ...query, cursor },
      ...(signal ? { signal } : {}),
    });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}
