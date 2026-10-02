/**
 * Modern -> legacy and legacy -> legacy fan-out (6.5): an `input_required` outcome becomes server-to-client requests
 * on the response stream of the POST; the answers are collected and the same operation is retried with
 * `inputResponses`. Capabilities the client did not declare are answered here without bothering the client.
 */
import { BastionError, JSONRPC_CODES, MAX_INPUT_ROUNDS } from '@bastion-mcp/core';
import { MethodNotFoundError } from '../rpc';
import type { ClientCaps, JsonObject, OpOutcome } from '../types';
import { partitionInputRequests } from './partition';

export type LegacyBridgeOptions = {
  /** Params of the original request (without `inputResponses`/`requestState`). */
  params: JsonObject;
  /** What the client declared; pass `{}` when the client cannot be asked (JSON-only response). */
  caps: ClientCaps;
  roots: (installationId: string) => Promise<readonly string[]>;
  run: (params: JsonObject) => Promise<OpOutcome<unknown>>;
  /** Sends one server-to-client request and resolves with the entry for `inputResponses`. */
  ask?: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  maxRounds?: number;
};

/** Drives an operation to completion, answering `input_required` rounds; returns the final result. */
export const driveLegacyInput = async (options: LegacyBridgeOptions): Promise<unknown> => {
  const maxRounds = options.maxRounds ?? MAX_INPUT_ROUNDS;
  let params = options.params;
  for (let round = 0; ; round += 1) {
    const outcome = await options.run(params);
    if (outcome.kind === 'complete') return outcome.result;
    if (outcome.kind === 'task')
      throw new MethodNotFoundError('tasks (not served to legacy clients)');
    if (round >= maxRounds) {
      throw new BastionError('TOO_MANY_INPUT_ROUNDS', 'too many input rounds', {
        httpStatus: 500,
        mcpCode: JSONRPC_CODES.INTERNAL_ERROR,
      });
    }
    const { forClient, local } = partitionInputRequests(
      outcome.inputRequests,
      options.ask ? options.caps : {},
      outcome.installationId === undefined ? [] : await options.roots(outcome.installationId),
    );
    const answers: Record<string, unknown> = { ...local };
    const ask = options.ask;
    await Promise.all(
      Object.entries(forClient).map(async ([key, entry]) => {
        answers[key] = ask
          ? await ask(entry.method, entry.params)
          : { error: { code: JSONRPC_CODES.METHOD_NOT_FOUND, message: 'client cannot be asked' } };
      }),
    );
    params = { ...options.params, inputResponses: answers, requestState: outcome.requestState };
  }
};
