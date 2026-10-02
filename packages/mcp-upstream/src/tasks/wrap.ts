import {
  AeadError,
  BastionError,
  JSONRPC_CODES,
  type Keyring,
  openJson,
  sealJson,
  TOKEN_PREFIXES,
} from '@bastion-mcp/core';
import { z } from 'zod';

/**
 * Tasks extension (6.8): a `CreateTaskResult` gets its `taskId` wrapped as `btk1.` + AEAD(`{p, i, upstreamTaskId, exp}`);
 * `tasks/get`, `tasks/update` and `tasks/cancel` unwrap and route to the installation the task belongs to.
 */

export const TASK_ID_PREFIX = TOKEN_PREFIXES.taskId;
/** Default lifetime of a wrapped task id when the upstream states none (24 hours). */
export const DEFAULT_TASK_TTL_SECONDS = 24 * 60 * 60;

export class InvalidTaskIdError extends BastionError {
  constructor(cause?: unknown) {
    super('INVALID_TASK_ID', 'invalid taskId', {
      httpStatus: 400,
      mcpCode: JSONRPC_CODES.INVALID_PARAMS,
      cause,
    });
  }
}

const payloadSchema = z.object({
  p: z.string(),
  i: z.string(),
  upstreamTaskId: z.string(),
  exp: z.number().int(),
});
export type TaskIdPayload = z.infer<typeof payloadSchema>;

export const wrapTaskId = (
  ring: Keyring,
  input: {
    principalId: string;
    installationId: string;
    upstreamTaskId: string;
    nowSeconds: number;
    ttlSeconds?: number;
  },
): string =>
  sealJson(
    {
      p: input.principalId,
      i: input.installationId,
      upstreamTaskId: input.upstreamTaskId,
      exp: input.nowSeconds + (input.ttlSeconds ?? DEFAULT_TASK_TTL_SECONDS),
    } satisfies TaskIdPayload,
    ring,
    { prefix: TASK_ID_PREFIX },
  );

/** Verifies the token for this principal and returns where it routes; `-32602` on anything else. */
export const unwrapTaskId = (
  ring: Keyring,
  taskId: string,
  principalId: string,
  nowSeconds: number,
): TaskIdPayload => {
  let payload: TaskIdPayload;
  try {
    payload = payloadSchema.parse(openJson(taskId, ring, { prefix: TASK_ID_PREFIX }));
  } catch (error) {
    if (error instanceof AeadError || error instanceof z.ZodError)
      throw new InvalidTaskIdError(error);
    throw error;
  }
  if (payload.p !== principalId || payload.exp < nowSeconds) throw new InvalidTaskIdError();
  return payload;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The task object inside a `CreateTaskResult`, `tasks/get` result or similar: `result.task` or the result itself. */
const taskRecordOf = (result: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (isObject(result.task) && typeof result.task.taskId === 'string') return result.task;
  if (typeof result.taskId === 'string') return result;
  return undefined;
};

/** Replaces the upstream `taskId` of a result with the wrapped one; other fields stay as the upstream sent them. */
export const wrapTaskResult = (
  ring: Keyring,
  result: unknown,
  input: { principalId: string; installationId: string; nowSeconds: number },
): unknown => {
  if (!isObject(result)) return result;
  const record = taskRecordOf(result);
  if (!record) return result;
  const upstreamTaskId = record.taskId as string;
  const ttlMs = typeof record.ttl === 'number' ? record.ttl : undefined;
  const wrapped = wrapTaskId(ring, {
    ...input,
    upstreamTaskId,
    ...(ttlMs === undefined ? {} : { ttlSeconds: Math.max(60, Math.ceil(ttlMs / 1000)) }),
  });
  return rewriteTaskId(result, wrapped);
};

/** Sets `taskId` (top level and under `task`) to `taskId`, e.g. to keep the client's wrapped id on a `tasks/get` result. */
export const rewriteTaskId = (result: unknown, taskId: string): unknown => {
  if (!isObject(result)) return result;
  const copy: Record<string, unknown> = { ...result };
  if (isObject(copy.task) && typeof copy.task.taskId === 'string') {
    copy.task = { ...copy.task, taskId };
  }
  if (typeof copy.taskId === 'string') copy.taskId = taskId;
  return copy;
};

export const isTaskMethod = (method: string): boolean =>
  method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel';
