/**
 * Missing downstream capabilities (6.5): before an input request goes to a client Bastion checks the capabilities
 * the client declared for it. Elicitation is answered `{ action: "decline" }`, sampling gets error `-32601`, roots get
 * the installation's configured roots. These answers go to the upstream and the client never sees the request.
 */
import { JSONRPC_CODES } from '@bastion-mcp/core';
import { answerMissingCapability, clientSupports } from '@bastion-mcp/mcp-upstream';
import type { InputRequestEntry, InputRequestMap } from '@bastion-mcp/mcp-upstream';
import type { ClientCaps } from '../types';

export type InputKind = 'elicitation' | 'sampling' | 'roots';

const KIND_OF_METHOD: Record<string, InputKind> = {
  'elicitation/create': 'elicitation',
  'sampling/createMessage': 'sampling',
  'roots/list': 'roots',
};

export const inputKindOf = (method: string): InputKind | undefined => KIND_OF_METHOD[method];

export type InputPartition = {
  /** Entries the client declared support for, to be sent to it. */
  forClient: InputRequestMap;
  /** Bastion's own answers, keyed like `inputRequests`, ready to merge into `inputResponses`. */
  local: Record<string, unknown>;
};

const answerLocally = (kind: InputKind, roots: readonly string[]): unknown => {
  try {
    return answerMissingCapability(kind, roots);
  } catch {
    // Sampling without the capability: JSON-RPC -32601 as an error entry (6.5).
    return {
      error: { code: JSONRPC_CODES.METHOD_NOT_FOUND, message: 'client does not support sampling' },
    };
  }
};

export const partitionInputRequests = (
  inputRequests: InputRequestMap | undefined,
  caps: ClientCaps,
  roots: readonly string[],
): InputPartition => {
  const forClient: InputRequestMap = {};
  const local: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(inputRequests ?? {})) {
    const kind = inputKindOf(entry.method);
    if (kind === undefined || clientSupports(caps, kind, entry.params)) {
      forClient[key] = entry as InputRequestEntry;
    } else {
      local[key] = answerLocally(kind, roots);
    }
  }
  return { forClient, local };
};

/** True when nothing is left for the client: the operation retries upstream by itself. */
export const fullyLocal = (partition: InputPartition): boolean =>
  Object.keys(partition.forClient).length === 0;
