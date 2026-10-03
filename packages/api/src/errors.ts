import { BastionError } from '@bastion-mcp/core';

/** Stable problem codes of the control-plane API (17.1: `type` = `<ERROR_BASE_URL>/<code>`). */
export const ERROR_BASE_URL = 'https://bastion-mcp.github.io/errors';

export type FieldError = { path: string; message: string };

export class ApiError extends BastionError {
  readonly errors: FieldError[];
  constructor(
    code: string,
    message: string,
    httpStatus: number,
    options: { errors?: FieldError[]; data?: Record<string, unknown> } = {},
  ) {
    super(code, message, { httpStatus, data: options.data ?? {} });
    this.errors = options.errors ?? [];
  }
}

export class NotFoundApiError extends ApiError {
  constructor(what = 'resource') {
    super('not_found', `${what} not found`, 404);
  }
}

export class ForbiddenApiError extends ApiError {
  constructor(message = 'not allowed to perform this action', data: Record<string, unknown> = {}) {
    super('forbidden', message, 403, { data });
  }
}

export class ValidationApiError extends ApiError {
  constructor(message: string, errors: FieldError[] = []) {
    super('validation_failed', message, 400, { errors });
  }
}

export class ConflictApiError extends ApiError {
  constructor(message: string, options: { code?: string; data?: Record<string, unknown> } = {}) {
    super(options.code ?? 'conflict', message, 409, { data: options.data ?? {} });
  }
}

export class PreconditionFailedError extends ApiError {
  constructor() {
    super('precondition_failed', 'the resource changed since it was read (If-Match mismatch)', 412);
  }
}

export class PreconditionRequiredError extends ApiError {
  constructor() {
    super('precondition_required', 'an If-Match header with the resource ETag is required', 428);
  }
}

export class IdempotencyKeyReuseError extends ApiError {
  constructor() {
    super(
      'idempotency_key_reuse',
      'this Idempotency-Key was already used with a different request',
      422,
    );
  }
}

export class UnavailableApiError extends ApiError {
  constructor(what: string) {
    super('unavailable', `${what} is not available`, 503);
  }
}
