/** JSON-RPC errors the downstream layer raises and how any thrown value maps onto them (6.9). */
import { BastionError, JSONRPC_CODES } from '@bastion-mcp/core';

/** Codes of the implementation range (-32000..-32099) the transports use that are not Bastion's own `ERROR_CODES`. */
export const TRANSPORT_CODES = {
  sessionNotFound: -32001,
  headerMismatch: -32020,
} as const;

export class InvalidParamsError extends BastionError {
  constructor(message: string, data?: Record<string, unknown>) {
    super('INVALID_PARAMS', message, {
      httpStatus: 400,
      mcpCode: JSONRPC_CODES.INVALID_PARAMS,
      ...(data ? { data } : {}),
    });
  }
}

export class MethodNotFoundError extends BastionError {
  constructor(method: string) {
    super('METHOD_NOT_FOUND', `Method not found: ${method}`, {
      httpStatus: 404,
      mcpCode: JSONRPC_CODES.METHOD_NOT_FOUND,
    });
  }
}

export class InvalidRequestError extends BastionError {
  constructor(message: string, data?: Record<string, unknown>) {
    super('INVALID_REQUEST', message, {
      httpStatus: 400,
      mcpCode: JSONRPC_CODES.INVALID_REQUEST,
      ...(data ? { data } : {}),
    });
  }
}

/** A tool, prompt or resource that does not exist or that the principal may not see: the same answer (6.9). */
export class UnknownItemError extends InvalidParamsError {
  constructor(kind: 'tool' | 'prompt' | 'resource', key: string) {
    super(`Unknown ${kind}: ${key}`);
  }
}

export type RpcErrorBody = {
  code: number;
  message: string;
  data?: Record<string, unknown>;
};

/** Never leaks the message of a non-Bastion error: those are bugs and become `-32603`. */
export const toRpcErrorBody = (error: unknown): RpcErrorBody => {
  if (error instanceof BastionError) {
    return {
      code: error.mcpCode ?? JSONRPC_CODES.INTERNAL_ERROR,
      message: error.message,
      ...(Object.keys(error.data).length === 0 ? {} : { data: error.data }),
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'number' &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { name?: string }).name === 'ProtocolError'
  ) {
    const e = error as { code: number; message: string; data?: unknown };
    return {
      code: e.code,
      message: e.message,
      ...(typeof e.data === 'object' && e.data !== null && !Array.isArray(e.data)
        ? { data: e.data as Record<string, unknown> }
        : {}),
    };
  }
  return { code: JSONRPC_CODES.INTERNAL_ERROR, message: 'Internal error' };
};

/** `error.type` span and metric attribute for a failed operation (15.2). */
export const errorTypeOf = (error: unknown): string =>
  error instanceof BastionError ? error.code : 'internal_error';
