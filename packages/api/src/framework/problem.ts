import { isBastionError } from '@bastion-mcp/core';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ApiError, ERROR_BASE_URL, type FieldError } from '../errors';

/** RFC 9457 problem document (17.1). */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  errors?: FieldError[];
  [extension: string]: unknown;
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const title = (status: number): string => TITLES[status] ?? 'Error';

export const problemType = (code: string): string => `${ERROR_BASE_URL}/${code}`;

export const makeProblem = (
  status: number,
  code: string,
  detail: string,
  extra: { instance?: string; errors?: FieldError[] } = {},
): Problem => ({
  type: problemType(code),
  title: title(status),
  status,
  detail,
  code,
  ...(extra.instance ? { instance: extra.instance } : {}),
  ...(extra.errors && extra.errors.length > 0 ? { errors: extra.errors } : {}),
});

type ZodIssueLike = { instancePath?: string; message?: string; params?: { issue?: unknown } };

const validationErrors = (error: unknown): FieldError[] => {
  if (!hasZodFastifySchemaValidationErrors(error)) return [];
  return error.validation.map((v: ZodIssueLike) => ({
    path: v.instancePath && v.instancePath.length > 0 ? v.instancePath : '/',
    message: v.message ?? 'invalid value',
  }));
};

/** Maps any thrown value to a problem. Unknown errors never leak their message (24.2). */
export const toProblem = (error: unknown, instance?: string): Problem => {
  const extra = instance ? { instance } : {};
  if (hasZodFastifySchemaValidationErrors(error)) {
    return makeProblem(400, 'validation_failed', 'the request is invalid', {
      ...extra,
      errors: validationErrors(error),
    });
  }
  if (error instanceof ApiError) {
    return makeProblem(error.httpStatus, error.code, error.message, {
      ...extra,
      errors: error.errors,
    });
  }
  if (isBastionError(error)) {
    return makeProblem(error.httpStatus, error.code.toLowerCase(), error.message, extra);
  }
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : 'bad request';
    return makeProblem(status, status === 404 ? 'not_found' : 'bad_request', message, extra);
  }
  return makeProblem(500, 'internal_error', 'an unexpected error occurred', extra);
};
