import { z } from 'zod';
import { AeadError, type Keyring, openJson, sealJson } from './aead';
import { canonicalDigest, sha256Hex } from './canonical';
import { JSONRPC_CODES, TOKEN_PREFIXES, TTL } from './constants';
import { BastionError } from './errors';

/**
 * Wrapped request state (6.5). Every `requestState` Bastion returns downstream is sealed and bound
 * to the principal, endpoint, installation, method, name and arguments of the original request.
 */

export const REQUEST_STATE_PREFIX = TOKEN_PREFIXES.requestState;
export const REQUEST_STATE_TTL_SECONDS = TTL.requestState;

export class RequestStateError extends BastionError {
  constructor(cause?: unknown) {
    super('INVALID_REQUEST_STATE', 'invalid requestState', {
      httpStatus: 400,
      mcpCode: JSONRPC_CODES.INVALID_PARAMS,
      cause,
    });
  }
}

export type RequestStateBinding = {
  principalId: string;
  endpointId: string;
  installationId: string;
  method: string;
  /** Downstream tool or prompt name, or resource URI. */
  name: string;
  /** Tool arguments, prompt arguments or the URI. */
  args: unknown;
};

const payloadSchema = z.object({
  v: z.literal(1),
  p: z.string(),
  e: z.string(),
  i: z.string(),
  m: z.string(),
  n: z.string(),
  a: z.string(),
  exp: z.number().int(),
  u: z.string().optional(),
  c: z.string().optional(),
  w: z.string().optional(),
});

export type UnwrappedRequestState = {
  upstreamState?: string;
  continuationId?: string;
  ownerWorkerId?: string;
};

export const wrapRequestState = (
  ring: Keyring,
  binding: RequestStateBinding,
  options: {
    now: number;
    upstreamState?: string;
    continuationId?: string;
    ownerWorkerId?: string;
  },
): string => {
  const payload: z.input<typeof payloadSchema> = {
    v: 1,
    p: binding.principalId,
    e: binding.endpointId,
    i: binding.installationId,
    m: binding.method,
    n: sha256Hex(binding.name),
    a: canonicalDigest(binding.args).toString('hex'),
    exp: options.now + REQUEST_STATE_TTL_SECONDS,
    ...(options.upstreamState === undefined ? {} : { u: options.upstreamState }),
    ...(options.continuationId === undefined ? {} : { c: options.continuationId }),
    ...(options.ownerWorkerId === undefined ? {} : { w: options.ownerWorkerId }),
  };
  return sealJson(payload, ring, { prefix: REQUEST_STATE_PREFIX });
};

/**
 * Decrypts and verifies a retry's state. Throws `RequestStateError` (JSON-RPC -32602,
 * "invalid requestState") on any mismatch or expiry; returns the upstream state to forward.
 */
export const unwrapRequestState = (
  ring: Keyring,
  state: string,
  binding: RequestStateBinding,
  options: { now: number },
): UnwrappedRequestState => {
  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(openJson(state, ring, { prefix: REQUEST_STATE_PREFIX }));
  } catch (error) {
    if (error instanceof AeadError || error instanceof z.ZodError)
      throw new RequestStateError(error);
    throw error;
  }
  const matches =
    payload.p === binding.principalId &&
    payload.e === binding.endpointId &&
    payload.i === binding.installationId &&
    payload.m === binding.method &&
    payload.n === sha256Hex(binding.name) &&
    payload.a === canonicalDigest(binding.args).toString('hex') &&
    payload.exp >= options.now;
  if (!matches) throw new RequestStateError();
  return {
    ...(payload.u === undefined ? {} : { upstreamState: payload.u }),
    ...(payload.c === undefined ? {} : { continuationId: payload.c }),
    ...(payload.w === undefined ? {} : { ownerWorkerId: payload.w }),
  };
};
