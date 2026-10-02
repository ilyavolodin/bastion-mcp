import {
  BastionError,
  isBastionError,
  JSONRPC_CODES,
  sanitizeUpstreamErrorMessage,
  UpstreamAuthRequiredError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import { ProtocolError, SdkError, SdkErrorCode, UnauthorizedError } from '@modelcontextprotocol/client';
import { AuthRequiredError } from './ports';

/** An upstream JSON-RPC error passed through unchanged except for truncation and stack removal (6.9). */
export class UpstreamRpcError extends BastionError {
  readonly rpcData: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super('UPSTREAM_ERROR', sanitizeUpstreamErrorMessage(message), {
      httpStatus: 502,
      mcpCode: code,
      ...(data === undefined ? {} : { data: { upstream: data } }),
    });
    this.rpcData = data;
  }
}

/** A continuation is gone: its owner died or the 10 minute TTL passed (6.5, 21.3). */
export class ContinuationLostError extends UpstreamUnavailableError {
  constructor(installation: string, cause?: unknown) {
    super('the upstream call this input belongs to is no longer running', { installation }, cause);
  }
}

export type ErrorContext = {
  installation: string;
  /** Timeout that applied to the call, for `-32017`. */
  timeoutMs?: number;
  connectUrl?: () => string | Promise<string>;
};

const HTTP_AUTH = new Set([401, 403]);

const httpStatusOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status;
  const data = (error as { data?: unknown }).data;
  if (typeof data === 'object' && data !== null) {
    const nested = (data as { status?: unknown }).status;
    if (typeof nested === 'number') return nested;
  }
  return undefined;
};

/**
 * Maps whatever the SDK or the transport threw into a `BastionError` (6.9):
 * upstream JSON-RPC errors pass through, timeouts become `-32017`, missing credentials `-32015`, and everything
 * else (refused connections, closed streams, oversized messages) `-32014`.
 */
export const mapUpstreamError = async (error: unknown, ctx: ErrorContext): Promise<BastionError> => {
  if (isBastionError(error)) return error;
  if (error instanceof AuthRequiredError) {
    return new UpstreamAuthRequiredError('upstream credential required', {
      installation: ctx.installation,
      connectUrl: ctx.connectUrl ? await ctx.connectUrl() : '',
    });
  }
  if (error instanceof UnauthorizedError) {
    return new UpstreamAuthRequiredError('upstream rejected the credential', {
      installation: ctx.installation,
      connectUrl: ctx.connectUrl ? await ctx.connectUrl() : '',
    });
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) {
      return new UpstreamTimeoutError(`upstream did not answer within ${ctx.timeoutMs ?? 0} ms`, {
        installation: ctx.installation,
        timeoutMs: ctx.timeoutMs ?? 0,
      });
    }
    const status = httpStatusOf(error);
    if (status !== undefined && HTTP_AUTH.has(status)) {
      return new UpstreamAuthRequiredError('upstream rejected the credential', {
        installation: ctx.installation,
        connectUrl: ctx.connectUrl ? await ctx.connectUrl() : '',
      });
    }
    return new UpstreamUnavailableError(
      sanitizeUpstreamErrorMessage(error.message),
      { installation: ctx.installation },
      error,
    );
  }
  if (error instanceof ProtocolError) {
    return new UpstreamRpcError(error.code, error.message, error.data);
  }
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'number' && code <= -32000 && code >= -32768) {
      return new UpstreamRpcError(code, String((error as { message: unknown }).message));
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UpstreamUnavailableError(
    sanitizeUpstreamErrorMessage(message || 'upstream unavailable'),
    { installation: ctx.installation },
    error,
  );
};

/** A BastionError as JSON-RPC error fields (`code`, `message`, `data`). */
export const toRpcError = (
  error: BastionError,
): { code: number; message: string; data?: Record<string, unknown> } => ({
  code: error.mcpCode ?? JSONRPC_CODES.INTERNAL_ERROR,
  message: error.message,
  ...(Object.keys(error.data).length === 0 ? {} : { data: error.data }),
});
