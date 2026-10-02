import { z } from 'zod';
import type { PolicyEngine } from './engine';
import { clockContext } from './entities';
import {
  type AuthorizeRequest,
  type McpRequestContext,
  policyActionSchema,
  principalSchema,
  requestContextSchema,
  resourceSchema,
} from './types';

/** Body of `POST /api/v1/policies/simulate` and of custom-policy test cases (10.4). */
export const simulateRequestSchema = z.object({
  principal: principalSchema,
  action: policyActionSchema,
  resource: resourceSchema,
  /** Any subset; the rest default to a neutral simulator client. */
  context: requestContextSchema.partial().default({}),
  /** `tools/call` arguments for `callTool` simulations. */
  call: z.record(z.string(), z.unknown()).optional(),
});
export type SimulateRequest = z.infer<typeof simulateRequestSchema>;
export type SimulateRequestInput = z.input<typeof simulateRequestSchema>;

export type SimulationResult = {
  decision: 'allow' | 'deny';
  reasons: string[];
  errors: string[];
  /** The determining policies' Cedar text, for the test bench. */
  determiningPolicies: Array<{ id: string; text: string }>;
};

export const simulationContext = (
  partial: { [K in keyof McpRequestContext]?: McpRequestContext[K] | undefined },
  now: Date = new Date(),
): McpRequestContext => ({
  clientId: partial.clientId ?? 'simulator',
  clientName: partial.clientName ?? 'Simulator',
  ip: partial.ip ?? '127.0.0.1',
  authMethod: partial.authMethod ?? 'simulate',
  endpoint: partial.endpoint ?? '/mcp',
  ...clockContext(now),
  ...(partial.hour !== undefined ? { hour: partial.hour } : {}),
  ...(partial.weekday !== undefined ? { weekday: partial.weekday } : {}),
});

/**
 * Decision and reasons for any principal, action, resource and context (10.4). Input is untrusted and
 * parsed with zod; evaluation uses exactly the production path.
 */
export const simulate = (
  engine: PolicyEngine,
  raw: unknown,
  now: Date = new Date(),
): SimulationResult => {
  const request = simulateRequestSchema.parse(raw);
  const authorize: AuthorizeRequest = {
    principal: request.principal,
    action: request.action,
    resource: request.resource,
    context: simulationContext(request.context, now),
    ...(request.call ? { call: request.call } : {}),
  };
  const decision = engine.authorize(authorize);
  return {
    ...decision,
    determiningPolicies: decision.reasons.flatMap((id) => {
      const text = engine.policyText(id);
      return text === undefined ? [] : [{ id, text }];
    }),
  };
};
