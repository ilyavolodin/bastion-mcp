import type { Era } from '@bastion-mcp/core';
import { z } from 'zod';
import type { CallPrincipal } from './ports';

export type JsonObject = Record<string, unknown>;

export const traceCarrierSchema = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
  baggage: z.string().optional(),
});
export type TraceCarrier = z.infer<typeof traceCarrierSchema>;

/** The downstream client's declared capabilities, as far as bridging cares (6.5). */
export const clientCapabilitiesSchema = z.looseObject({
  elicitation: z
    .looseObject({ form: z.looseObject({}).optional(), url: z.looseObject({}).optional() })
    .optional(),
  sampling: z.looseObject({}).optional(),
  roots: z.looseObject({}).optional(),
});
export type ClientCapabilitiesLike = z.infer<typeof clientCapabilitiesSchema>;

export const principalSchema = z.object({
  userId: z.string(),
  type: z.enum(['user', 'service']).optional(),
  clientName: z.string().optional(),
  email: z.string().optional(),
  teams: z.array(z.string()).optional(),
});

/** The part of an operation context that crosses the internal RPC (21.2). */
export const wireContextSchema = z.object({
  principal: principalSchema,
  installationId: z.string(),
  era: z.enum(['modern', 'legacy']),
  clientCapabilities: clientCapabilitiesSchema,
  logLevel: z.string().optional(),
  trace: traceCarrierSchema,
  /** Epoch milliseconds after which the owner gives up. */
  deadlineAt: z.number().optional(),
  endpointId: z.string().optional(),
  /** Single-installation endpoints forward unknown extensions verbatim (6.8). */
  singleInstallationEndpoint: z.boolean().optional(),
  /** Downstream name (or URI) used in the requestState binding (6.5). */
  downstreamName: z.string().optional(),
});
export type WireContext = z.infer<typeof wireContextSchema>;

export type UpstreamNotification = { method: string; params?: JsonObject };

/** Local context: the wire part plus the abort signal and notification emitter, which never cross the wire. */
export type UpstreamCallContext = Omit<WireContext, 'principal'> & {
  principal: CallPrincipal;
  signal?: AbortSignal | undefined;
  /** Progress and log notifications for this request. */
  emit?: ((notification: UpstreamNotification) => void) | undefined;
};

export const toWireContext = (ctx: UpstreamCallContext): WireContext => ({
  principal: ctx.principal,
  installationId: ctx.installationId,
  era: ctx.era,
  clientCapabilities: ctx.clientCapabilities,
  trace: ctx.trace,
  ...(ctx.logLevel === undefined ? {} : { logLevel: ctx.logLevel }),
  ...(ctx.deadlineAt === undefined ? {} : { deadlineAt: ctx.deadlineAt }),
  ...(ctx.endpointId === undefined ? {} : { endpointId: ctx.endpointId }),
  ...(ctx.singleInstallationEndpoint === undefined
    ? {}
    : { singleInstallationEndpoint: ctx.singleInstallationEndpoint }),
  ...(ctx.downstreamName === undefined ? {} : { downstreamName: ctx.downstreamName }),
});

export type InputRequestEntry = { method: string; params?: unknown };
export type InputRequestMap = Record<string, InputRequestEntry>;

/**
 * The OpOutcome shape of 6.2: an operation completes, needs input, or started a task. `input_required` carries a
 * `requestState` that Bastion has already wrapped (6.5).
 */
export type UpstreamOutcome =
  | { kind: 'complete'; result: unknown }
  | { kind: 'input_required'; inputRequests?: InputRequestMap; requestState: string }
  | { kind: 'task'; task: unknown };

export const wireOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete'), result: z.unknown() }),
  z.object({
    kind: z.literal('input_required'),
    inputRequests: z
      .record(z.string(), z.object({ method: z.string(), params: z.unknown().optional() }))
      .optional(),
    requestState: z.string(),
  }),
  z.object({ kind: z.literal('task'), task: z.unknown() }),
]);

/** Session level outcome, before Bastion wraps `requestState`. */
export type SessionOutcome =
  | { kind: 'complete'; result: unknown }
  | {
      kind: 'input_required';
      inputRequests?: InputRequestMap | undefined;
      /** The upstream's own state (modern upstreams). */
      upstreamState?: string | undefined;
      /** Set for legacy upstream continuations (6.5). */
      continuationId?: string | undefined;
    }
  | { kind: 'task'; task: unknown };

export type { Era };
