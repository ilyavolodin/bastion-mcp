import { BastionError } from '@bastion-mcp/core';

/** Raised when policy generation receives data that cannot be compiled to safe Cedar text (10.3). */
export class PolicyGenerationError extends BastionError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super('POLICY_INVALID', message, { httpStatus: 400, data });
  }
}

/** Raised when a request cannot be evaluated (missing context, engine failure). Never a silent allow. */
export class PolicyEvaluationError extends BastionError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super('POLICY_EVALUATION_FAILED', message, { httpStatus: 500, data });
  }
}
