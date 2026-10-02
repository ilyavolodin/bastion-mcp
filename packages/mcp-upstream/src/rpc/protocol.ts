import {
  BastionError,
  ERROR_CODES,
  JSONRPC_CODES,
  RateLimitedError,
  SandboxStartFailedError,
  UpstreamAuthRequiredError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import { z } from 'zod';
import { UpstreamRpcError } from '../errors';
import { wireContextSchema, wireOutcomeSchema } from '../types';

/** Wire formats of the internal RPC (21.2). The prefix is versioned. */

export const RPC_PREFIX = '/internal/v1';

export const opBodySchema = z.object({
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  ctx: wireContextSchema,
});
export type OpBody = z.infer<typeof opBodySchema>;

export const resumeBodySchema = z.object({
  inputResponses: z.record(z.string(), z.unknown()),
  ctx: wireContextSchema,
});
export type ResumeBody = z.infer<typeof resumeBodySchema>;

export const subscriptionBodySchema = z.object({
  action: z.enum(['add', 'remove']),
  /** `resource` subscribes to one URI, `list` expresses interest in list_changed notifications. */
  kind: z.enum(['resource', 'list']),
  uri: z.string().optional(),
  principalId: z.string(),
  endpointId: z.string().optional(),
  ctx: wireContextSchema,
});
export type SubscriptionBody = z.infer<typeof subscriptionBodySchema>;

export const sessionResponseBodySchema = z.object({ message: z.unknown() });

export type OpEvent =
  | { type: 'notification'; method: string; params?: Record<string, unknown> | undefined }
  | { type: 'outcome'; outcome: z.infer<typeof wireOutcomeSchema> }
  | {
      type: 'error';
      code: number;
      bastionCode?: string | undefined;
      message: string;
      data?: Record<string, unknown> | undefined;
    };

export const opEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notification'),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('outcome'), outcome: wireOutcomeSchema }),
  z.object({
    type: z.literal('error'),
    code: z.number(),
    bastionCode: z.string().optional(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type Route =
  | { kind: 'op'; instanceId: string }
  | { kind: 'resume'; continuationId: string }
  | { kind: 'subscriptions'; instanceId: string }
  | { kind: 'sessionResponse'; sessionId: string };

const ID = '([^/]+)';

/** Matches the four routes of 21.2; null for anything else. */
export const matchRoute = (method: string, path: string): Route | null => {
  if (method.toUpperCase() !== 'POST') return null;
  let m = new RegExp(`^${RPC_PREFIX}/instances/${ID}/op$`).exec(path);
  if (m) return { kind: 'op', instanceId: decodeURIComponent(m[1] as string) };
  m = new RegExp(`^${RPC_PREFIX}/continuations/${ID}/resume$`).exec(path);
  if (m) return { kind: 'resume', continuationId: decodeURIComponent(m[1] as string) };
  m = new RegExp(`^${RPC_PREFIX}/instances/${ID}/subscriptions$`).exec(path);
  if (m) return { kind: 'subscriptions', instanceId: decodeURIComponent(m[1] as string) };
  m = new RegExp(`^${RPC_PREFIX}/sessions/${ID}/responses$`).exec(path);
  if (m) return { kind: 'sessionResponse', sessionId: decodeURIComponent(m[1] as string) };
  return null;
};

export const opPath = (instanceId: string): string =>
  `${RPC_PREFIX}/instances/${encodeURIComponent(instanceId)}/op`;
export const resumePath = (continuationId: string): string =>
  `${RPC_PREFIX}/continuations/${encodeURIComponent(continuationId)}/resume`;
export const subscriptionsPath = (instanceId: string): string =>
  `${RPC_PREFIX}/instances/${encodeURIComponent(instanceId)}/subscriptions`;
export const sessionResponsePath = (sessionId: string): string =>
  `${RPC_PREFIX}/sessions/${encodeURIComponent(sessionId)}/responses`;

/** A thrown error as the `error` event (6.9). */
export const toErrorEvent = (error: unknown): Extract<OpEvent, { type: 'error' }> => {
  if (error instanceof BastionError) {
    return {
      type: 'error',
      code: error.mcpCode ?? JSONRPC_CODES.INTERNAL_ERROR,
      bastionCode: error.code,
      message: error.message,
      ...(Object.keys(error.data).length === 0 ? {} : { data: error.data }),
    };
  }
  return {
    type: 'error',
    code: JSONRPC_CODES.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
  };
};

/** Rebuilds the typed error on the receiving side so `-32014`..`-32017` keep their meaning across the hop. */
export const fromErrorEvent = (event: Extract<OpEvent, { type: 'error' }>): BastionError => {
  const data = event.data ?? {};
  const installation = typeof data.installation === 'string' ? data.installation : '';
  switch (event.code) {
    case ERROR_CODES.UPSTREAM_UNAVAILABLE:
      return new UpstreamUnavailableError(event.message, { installation });
    case ERROR_CODES.UPSTREAM_AUTH_REQUIRED:
      return new UpstreamAuthRequiredError(event.message, {
        installation,
        connectUrl: typeof data.connectUrl === 'string' ? data.connectUrl : '',
      });
    case ERROR_CODES.SANDBOX_START_FAILED:
      return new SandboxStartFailedError(event.message, {
        installation,
        phase: typeof data.phase === 'string' ? data.phase : '',
      });
    case ERROR_CODES.UPSTREAM_TIMEOUT:
      return new UpstreamTimeoutError(event.message, {
        installation,
        timeoutMs: typeof data.timeoutMs === 'number' ? data.timeoutMs : 0,
      });
    case ERROR_CODES.RATE_LIMITED:
      return new RateLimitedError(event.message, {
        retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : 0,
        limit: typeof data.limit === 'string' ? data.limit : '',
      });
    default:
      return new UpstreamRpcError(event.code, event.message, data.upstream);
  }
};
