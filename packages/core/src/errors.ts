import { ERROR_CODES, MAX_UPSTREAM_ERROR_MESSAGE, META_KEYS } from './constants';

/**
 * Every failure Bastion raises on purpose is a BastionError (5.4): a stable `code`, an HTTP status
 * and, where relevant, a JSON-RPC `mcpCode` (6.9).
 */
export class BastionError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly mcpCode: number | undefined;
  /** Denials the model should read and adapt to are returned as tool results (6.9). */
  readonly isToolResult: boolean = false;
  readonly data: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      httpStatus: number;
      mcpCode?: number;
      data?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.mcpCode = options.mcpCode;
    this.data = options.data ?? {};
  }
}

export const isBastionError = (value: unknown): value is BastionError =>
  value instanceof BastionError;

abstract class ToolResultError extends BastionError {
  override readonly isToolResult = true;
}

export class PolicyDeniedError extends ToolResultError {
  constructor(message: string, data: { reason?: string; policyIds?: string[] } = {}) {
    super('POLICY_DENIED', message, {
      httpStatus: 403,
      mcpCode: ERROR_CODES.POLICY_DENIED,
      data,
    });
  }
}

export class RateLimitedError extends ToolResultError {
  constructor(message: string, data: { retryAfterMs: number; limit: string }) {
    super('RATE_LIMITED', message, { httpStatus: 429, mcpCode: ERROR_CODES.RATE_LIMITED, data });
  }
}

export class QuotaExceededError extends ToolResultError {
  constructor(message: string, data: { resetsAt: string; quota: string }) {
    super('QUOTA_EXCEEDED', message, {
      httpStatus: 429,
      mcpCode: ERROR_CODES.QUOTA_EXCEEDED,
      data,
    });
  }
}

export class GuardBlockedError extends ToolResultError {
  constructor(message: string, data: { guard: string; ruleId: string }) {
    super('GUARD_BLOCKED', message, { httpStatus: 403, mcpCode: ERROR_CODES.GUARD_BLOCKED, data });
  }
}

export class UpstreamUnavailableError extends BastionError {
  constructor(message: string, data: { installation: string }, cause?: unknown) {
    super('UPSTREAM_UNAVAILABLE', message, {
      httpStatus: 502,
      mcpCode: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      data,
      cause,
    });
  }
}

export class UpstreamAuthRequiredError extends BastionError {
  constructor(message: string, data: { installation: string; connectUrl: string }) {
    super('UPSTREAM_AUTH_REQUIRED', message, {
      httpStatus: 401,
      mcpCode: ERROR_CODES.UPSTREAM_AUTH_REQUIRED,
      data,
    });
  }
}

export class SandboxStartFailedError extends BastionError {
  constructor(
    message: string,
    data: { installation: string; phase: string; detail?: string; stderrTail?: string[] },
    cause?: unknown,
  ) {
    super('SANDBOX_START_FAILED', message, {
      httpStatus: 502,
      mcpCode: ERROR_CODES.SANDBOX_START_FAILED,
      data,
      cause,
    });
  }
}

export class UpstreamTimeoutError extends BastionError {
  constructor(message: string, data: { installation: string; timeoutMs: number }) {
    super('UPSTREAM_TIMEOUT', message, {
      httpStatus: 504,
      mcpCode: ERROR_CODES.UPSTREAM_TIMEOUT,
      data,
    });
  }
}

export type ToolErrorResult = {
  isError: true;
  content: { type: 'text'; text: string }[];
  _meta: Record<string, unknown>;
};

/** Converts a denial into a `tools/call` result so the model can read and adapt (6.9). */
export const toToolErrorResult = (error: BastionError): ToolErrorResult => ({
  isError: true,
  content: [{ type: 'text', text: error.message }],
  _meta: { [META_KEYS.error]: { code: error.code, ...error.data } },
});

/** Upstream JSON-RPC errors pass through, truncated, without stack traces (6.9). */
export const sanitizeUpstreamErrorMessage = (message: string): string => {
  const firstLines = message.split('\n').filter((line) => !/^\s+at\s/.test(line));
  return firstLines.join('\n').trimEnd().slice(0, MAX_UPSTREAM_ERROR_MESSAGE);
};
