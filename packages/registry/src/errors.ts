import { BastionError } from '@bastion-mcp/core';

/** The registry could not be reached, timed out or answered with an error status (21.3). */
export class RegistryUnavailableError extends BastionError {
  constructor(message: string, options?: { cause?: unknown; data?: Record<string, unknown> }) {
    super('registry_unavailable', message, { httpStatus: 502, ...options });
  }
}

/** The registry answered with a body that does not match the v0.1 API schema. */
export class RegistryInvalidResponseError extends BastionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('registry_invalid_response', message, { httpStatus: 502, ...options });
  }
}

export class RegistryNotFoundError extends BastionError {
  constructor(message: string) {
    super('registry_not_found', message, { httpStatus: 404 });
  }
}

/** A registry base URL is not allowed (SSRF guard, 8.8). */
export class RegistryUrlDeniedError extends BastionError {
  constructor(message: string) {
    super('registry_url_denied', message, { httpStatus: 400 });
  }
}

/** A `server.json` or client config cannot be turned into a ServerSpec (11.3, 11.6). */
export class RegistryMappingError extends BastionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('registry_mapping_failed', message, { httpStatus: 422, ...options });
  }
}

/** An install request transition that the state machine forbids (11.7). */
export class InstallRequestStateError extends BastionError {
  constructor(message: string) {
    super('install_request_invalid_state', message, { httpStatus: 409 });
  }
}

export class InstallRequestForbiddenError extends BastionError {
  constructor(message: string) {
    super('install_request_forbidden', message, { httpStatus: 403 });
  }
}
