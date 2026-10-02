import { BastionError } from '@bastion-mcp/core';

/** 401 for a missing or invalid credential; carries the exact `WWW-Authenticate` challenge (6.9). */
export class AuthenticationError extends BastionError {
  readonly wwwAuthenticate: string;
  constructor(
    code: 'UNAUTHENTICATED' | 'INVALID_TOKEN',
    message: string,
    wwwAuthenticate: string,
    reason?: string,
  ) {
    super(code, message, {
      httpStatus: 401,
      data: reason === undefined ? {} : { reason },
    });
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/** 403 `insufficient_scope` (6.9). */
export class InsufficientScopeError extends BastionError {
  readonly wwwAuthenticate: string;
  constructor(message: string, wwwAuthenticate: string, requiredScope: string) {
    super('INSUFFICIENT_SCOPE', message, { httpStatus: 403, data: { requiredScope } });
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export class CsrfError extends BastionError {
  constructor() {
    super('CSRF_FAILED', 'CSRF token missing or invalid', { httpStatus: 403 });
  }
}

export class ProvisioningDeniedError extends BastionError {
  constructor(message: string, reason: string) {
    super('PROVISIONING_DENIED', message, { httpStatus: 403, data: { reason } });
  }
}

export class IdentityValidationError extends BastionError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, { httpStatus: 400, data });
  }
}

export class IdentityNotFoundError extends BastionError {
  constructor(message: string) {
    super('NOT_FOUND', message, { httpStatus: 404 });
  }
}
