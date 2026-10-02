import { JSONRPC_CODES } from '@bastion-mcp/core';
import { ProtocolError } from '@modelcontextprotocol/client';
import type { ClientCapabilitiesLike, InputRequestMap } from '../types';

/**
 * Pure helpers of the upstream side of input-required bridging (6.5): request keying, capability checks and the
 * answers Bastion gives itself when the downstream client cannot be asked.
 */

export type ServerRequestKind = 'elicitation' | 'sampling' | 'roots';

export const METHOD_OF_KIND: Record<ServerRequestKind, string> = {
  elicitation: 'elicitation/create',
  sampling: 'sampling/createMessage',
  roots: 'roots/list',
};

/** `inputRequests` keys of one continuation batch are `b0`, `b1`, ... (6.5). */
export const inputRequestKey = (index: number): string => `b${index}`;

export type BatchEntry = { kind: ServerRequestKind; params: unknown };

/** Turns the requests of one debounce window into the `inputRequests` map keyed `b0`, `b1`, ... */
export const toInputRequests = (batch: readonly BatchEntry[]): InputRequestMap => {
  const out: InputRequestMap = {};
  batch.forEach((entry, index) => {
    out[inputRequestKey(index)] = { method: METHOD_OF_KIND[entry.kind], params: entry.params };
  });
  return out;
};

/**
 * Whether the downstream client declared the capability for this request (6.5): `elicitation.form` or
 * `elicitation.url` by mode (a bare `elicitation: {}` means form only), `sampling`, `roots`.
 */
export const clientSupports = (
  capabilities: ClientCapabilitiesLike,
  kind: ServerRequestKind,
  params: unknown,
): boolean => {
  switch (kind) {
    case 'elicitation': {
      const elicitation = capabilities.elicitation;
      if (!elicitation) return false;
      const mode =
        typeof params === 'object' && params !== null && (params as { mode?: unknown }).mode === 'url'
          ? 'url'
          : 'form';
      if (mode === 'url') return elicitation.url !== undefined;
      return elicitation.form !== undefined || elicitation.url === undefined;
    }
    case 'sampling':
      return capabilities.sampling !== undefined;
    case 'roots':
      return capabilities.roots !== undefined;
  }
};

export type DirectAnswer = { handled: true; result: unknown } | { handled: false };

/**
 * The answer Bastion gives to an upstream request when the downstream client lacks the capability (6.5):
 * elicitation `{action:"decline"}`, sampling `-32601`, roots the installation's configured roots.
 * Throws `ProtocolError` for sampling.
 */
export const answerMissingCapability = (
  kind: ServerRequestKind,
  roots: readonly string[],
): unknown => {
  switch (kind) {
    case 'elicitation':
      return { action: 'decline' };
    case 'sampling':
      throw new ProtocolError(JSONRPC_CODES.METHOD_NOT_FOUND, 'client does not support sampling');
    case 'roots':
      return { roots: roots.map((uri) => ({ uri })) };
  }
};

/** TTL expiry (6.5): elicitations `{action:"cancel"}`, sampling and roots JSON-RPC `-32603`. */
export const answerExpired = (kind: ServerRequestKind): unknown => {
  if (kind === 'elicitation') return { action: 'cancel' };
  throw new ProtocolError(JSONRPC_CODES.INTERNAL_ERROR, 'the downstream client did not answer in time');
};

/** An `inputResponses` entry the downstream client sent as a JSON-RPC style error. */
export const asErrorResponse = (value: unknown): { code: number; message: string } | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (typeof error !== 'object' || error === null) return undefined;
  if ('action' in record || 'roots' in record || 'role' in record) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: typeof code === 'number' ? code : JSONRPC_CODES.INTERNAL_ERROR,
    message: typeof message === 'string' ? message : 'client error',
  };
};

/** Maximum rounds of input per original request (6.5). */
export { MAX_INPUT_ROUNDS } from '@bastion-mcp/core';
