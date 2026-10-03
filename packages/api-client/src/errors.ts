/** RFC 9457 problem document returned by the API (17.1). */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  errors?: Array<{ path: string; message: string }>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Builds a problem from a response body; falls back to a synthetic one for non-problem failures. */
export const problemFromBody = (status: number, body: unknown, text: string): Problem => {
  if (isRecord(body) && typeof body.code === 'string' && typeof body.title === 'string') {
    return {
      type: typeof body.type === 'string' ? body.type : 'about:blank',
      title: body.title,
      status: typeof body.status === 'number' ? body.status : status,
      detail: typeof body.detail === 'string' ? body.detail : '',
      code: body.code,
      ...(typeof body.instance === 'string' ? { instance: body.instance } : {}),
      ...(Array.isArray(body.errors)
        ? {
            errors: body.errors.flatMap((e: unknown) =>
              isRecord(e) && typeof e.path === 'string' && typeof e.message === 'string'
                ? [{ path: e.path, message: e.message }]
                : [],
            ),
          }
        : {}),
    };
  }
  return {
    type: 'about:blank',
    title: `HTTP ${status}`,
    status,
    detail: text.slice(0, 200),
    code: 'http_error',
  };
};

export class ApiProblemError extends Error {
  readonly problem: Problem;
  readonly status: number;
  readonly code: string;
  /** `WWW-Authenticate` challenge on 401 and insufficient-scope 403 responses. */
  readonly wwwAuthenticate: string | undefined;

  constructor(problem: Problem, wwwAuthenticate?: string) {
    super(`${problem.status} ${problem.code}: ${problem.detail}`);
    this.name = 'ApiProblemError';
    this.problem = problem;
    this.status = problem.status;
    this.code = problem.code;
    this.wwwAuthenticate = wwwAuthenticate;
  }

  get fieldErrors(): Array<{ path: string; message: string }> {
    return this.problem.errors ?? [];
  }

  /** True when the change lost an optimistic-concurrency race (412 stale `If-Match`): re-read and retry. */
  get isStale(): boolean {
    return this.status === 412;
  }

  /** True for 412 (stale `If-Match`) or 409 (state conflict): re-read and retry, or surface the clash. */
  get isConflict(): boolean {
    return this.status === 412 || this.status === 409;
  }
}

export const isApiProblemError = (e: unknown): e is ApiProblemError => e instanceof ApiProblemError;
