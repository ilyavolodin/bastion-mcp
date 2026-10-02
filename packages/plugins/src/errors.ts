import { BastionError } from '@bastion-mcp/core';

/** A skill, plugin, archive or repository that violates the rules of 25.2. */
export class PluginValidationError extends BastionError {
  constructor(reason: string, data: Record<string, unknown> = {}) {
    super('PLUGIN_INVALID', reason, { httpStatus: 422, data: { reason, ...data } });
  }
}

/** A release, marketplace or source that does not exist or is in the wrong state. */
export class PluginStateError extends BastionError {
  constructor(code: string, message: string, httpStatus = 409) {
    super(code, message, { httpStatus });
  }
}
