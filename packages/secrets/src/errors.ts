import { BastionError } from '@bastion-mcp/core';

/** Authentication of a secret failed (tampering, wrong AAD, wrong key). */
export class SecretIntegrityError extends BastionError {
  constructor(message = 'secret failed authentication') {
    super('SECRET_INTEGRITY', message, { httpStatus: 500 });
  }
}

/** The KMS could not be reached or refused the request. */
export class KmsUnavailableError extends BastionError {
  constructor(message: string, cause?: unknown) {
    super('KMS_UNAVAILABLE', message, { httpStatus: 503, cause });
  }
}

export class SecretNotFoundError extends BastionError {
  constructor(message = 'secret not found') {
    super('SECRET_NOT_FOUND', message, { httpStatus: 404 });
  }
}
