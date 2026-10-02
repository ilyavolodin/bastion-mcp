/**
 * Metrics registry (15.3). Names, types and units follow the 15.3 table. User IDs never appear as metric
 * attributes (cardinality): the attribute types forbid them and a runtime guard rejects them.
 */
import type { Meter } from '@opentelemetry/api';

/** Attribute keys that identify a user or principal and are therefore banned on metrics (15.3). */
export const FORBIDDEN_METRIC_ATTRIBUTES: readonly string[] = [
  'user.id',
  'user_id',
  'userId',
  'enduser.id',
  'principal.id',
  'principal_id',
  'principalId',
  'bastion.user.id',
  'bastion.principal.id',
];

export class MetricCardinalityError extends Error {
  constructor(key: string) {
    super(
      `metric attribute "${key}" is forbidden: user IDs must never be metric attributes (15.3)`,
    );
    this.name = 'MetricCardinalityError';
  }
}

/** Throws when an attribute map carries a user or principal identifier. */
export const assertNoUserIdAttributes = (attributes: object | undefined): void => {
  if (attributes === undefined) return;
  for (const key of Object.keys(attributes)) {
    if (FORBIDDEN_METRIC_ATTRIBUTES.includes(key)) throw new MetricCardinalityError(key);
  }
};

type Forbidden = {
  readonly 'user.id'?: never;
  readonly user_id?: never;
  readonly userId?: never;
  readonly 'enduser.id'?: never;
  readonly 'principal.id'?: never;
  readonly principal_id?: never;
  readonly principalId?: never;
  readonly 'bastion.user.id'?: never;
  readonly 'bastion.principal.id'?: never;
};

/** Attribute map with banned identifier keys excluded at the type level. */
export type MetricAttrs<A extends Record<string, string | number | boolean | undefined>> = A &
  Forbidden;

export interface TypedCounter<A extends object> {
  add(value: number, attributes?: A & Forbidden): void;
}
export interface TypedHistogram<A extends object> {
  record(value: number, attributes?: A & Forbidden): void;
}
export interface TypedGauge<A extends object> {
  record(value: number, attributes?: A & Forbidden): void;
}

type None = Record<never, never>;
type Str = string | undefined;

export interface McpOperationAttrs {
  'mcp.method.name': string;
  'gen_ai.tool.name'?: Str;
  'error.type'?: Str;
}
export interface McpClientOperationAttrs extends McpOperationAttrs {
  'bastion.catalog.entry'?: Str;
}

export interface BastionMetrics {
  mcpServerOperationDuration: TypedHistogram<McpOperationAttrs>;
  mcpClientOperationDuration: TypedHistogram<McpClientOperationAttrs>;
  mcpServerSessionDuration: TypedHistogram<None>;
  calls: TypedCounter<{ 'bastion.catalog.entry': string; outcome: string }>;
  guardEvaluations: TypedCounter<{ guard: string; phase: string; verdict: string; action: string }>;
  guardDuration: TypedHistogram<{ guard: string }>;
  limitsRejections: TypedCounter<{ rule: string; kind: string }>;
  sandboxStarts: TypedCounter<{ driver: string; outcome: string; warm: boolean }>;
  sandboxStartDuration: TypedHistogram<{ driver: string; phase: string }>;
  sandboxesActive: TypedGauge<{ driver: string; size: string }>;
  instancesActive: TypedGauge<{ kind: 'remote' | 'sandbox' }>;
  streamsActive: TypedGauge<{ era: string; type: 'listen' | 'legacy_get' | 'response' }>;
  forwardedRequests: TypedCounter<{ outcome: string }>;
  upstreamOauthRefreshes: TypedCounter<{ outcome: string }>;
  egressConnections: TypedCounter<{ decision: string }>;
  configCompileDuration: TypedHistogram<None>;
  calllogDropped: TypedCounter<None>;
  pluginsFetches: TypedCounter<{ channel: 'git' | 'https' | 'mirror'; marketplace: string }>;
  limitsDegraded: TypedCounter<{ rule?: Str; kind?: Str }>;
}

/** Instrument names, units and descriptions exactly as in 15.3. */
export const METRIC_DEFS = {
  mcpServerOperationDuration: {
    name: 'mcp.server.operation.duration',
    type: 'histogram',
    unit: 's',
  },
  mcpClientOperationDuration: {
    name: 'mcp.client.operation.duration',
    type: 'histogram',
    unit: 's',
  },
  mcpServerSessionDuration: { name: 'mcp.server.session.duration', type: 'histogram', unit: 's' },
  calls: { name: 'bastion.calls', type: 'counter', unit: '{call}' },
  guardEvaluations: { name: 'bastion.guard.evaluations', type: 'counter', unit: '{evaluation}' },
  guardDuration: { name: 'bastion.guard.duration', type: 'histogram', unit: 's' },
  limitsRejections: { name: 'bastion.limits.rejections', type: 'counter', unit: '{rejection}' },
  sandboxStarts: { name: 'bastion.sandbox.starts', type: 'counter', unit: '{start}' },
  sandboxStartDuration: { name: 'bastion.sandbox.start.duration', type: 'histogram', unit: 's' },
  sandboxesActive: { name: 'bastion.sandboxes.active', type: 'gauge', unit: '{sandbox}' },
  instancesActive: { name: 'bastion.instances.active', type: 'gauge', unit: '{instance}' },
  streamsActive: { name: 'bastion.streams.active', type: 'gauge', unit: '{stream}' },
  forwardedRequests: { name: 'bastion.forwarded.requests', type: 'counter', unit: '{request}' },
  upstreamOauthRefreshes: {
    name: 'bastion.upstream.oauth.refreshes',
    type: 'counter',
    unit: '{refresh}',
  },
  egressConnections: { name: 'bastion.egress.connections', type: 'counter', unit: '{connection}' },
  configCompileDuration: { name: 'bastion.config.compile.duration', type: 'histogram', unit: 's' },
  calllogDropped: { name: 'bastion.calllog.dropped', type: 'counter', unit: '{row}' },
  pluginsFetches: { name: 'bastion.plugins.fetches', type: 'counter', unit: '{fetch}' },
  limitsDegraded: { name: 'bastion.limits.degraded', type: 'counter', unit: '{event}' },
} as const;

type Attrs = Record<string, string | number | boolean | undefined>;

const clean = (attributes: object | undefined): Attrs | undefined => {
  assertNoUserIdAttributes(attributes);
  if (attributes === undefined) return undefined;
  const out: Attrs = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
};

/** Create every 15.3 instrument on `meter`, guarded against user-ID attributes. */
export const createMetrics = (meter: Meter): BastionMetrics => {
  const counter = <A extends object>(def: { name: string; unit: string }): TypedCounter<A> => {
    const inst = meter.createCounter(def.name, { unit: def.unit });
    return { add: (value, attributes) => inst.add(value, clean(attributes)) };
  };
  const histogram = <A extends object>(def: { name: string; unit: string }): TypedHistogram<A> => {
    const inst = meter.createHistogram(def.name, { unit: def.unit });
    return { record: (value, attributes) => inst.record(value, clean(attributes)) };
  };
  const gauge = <A extends object>(def: { name: string; unit: string }): TypedGauge<A> => {
    const inst = meter.createGauge(def.name, { unit: def.unit });
    return { record: (value, attributes) => inst.record(value, clean(attributes)) };
  };
  return {
    mcpServerOperationDuration: histogram(METRIC_DEFS.mcpServerOperationDuration),
    mcpClientOperationDuration: histogram(METRIC_DEFS.mcpClientOperationDuration),
    mcpServerSessionDuration: histogram(METRIC_DEFS.mcpServerSessionDuration),
    calls: counter(METRIC_DEFS.calls),
    guardEvaluations: counter(METRIC_DEFS.guardEvaluations),
    guardDuration: histogram(METRIC_DEFS.guardDuration),
    limitsRejections: counter(METRIC_DEFS.limitsRejections),
    sandboxStarts: counter(METRIC_DEFS.sandboxStarts),
    sandboxStartDuration: histogram(METRIC_DEFS.sandboxStartDuration),
    sandboxesActive: gauge(METRIC_DEFS.sandboxesActive),
    instancesActive: gauge(METRIC_DEFS.instancesActive),
    streamsActive: gauge(METRIC_DEFS.streamsActive),
    forwardedRequests: counter(METRIC_DEFS.forwardedRequests),
    upstreamOauthRefreshes: counter(METRIC_DEFS.upstreamOauthRefreshes),
    egressConnections: counter(METRIC_DEFS.egressConnections),
    configCompileDuration: histogram(METRIC_DEFS.configCompileDuration),
    calllogDropped: counter(METRIC_DEFS.calllogDropped),
    pluginsFetches: counter(METRIC_DEFS.pluginsFetches),
    limitsDegraded: counter(METRIC_DEFS.limitsDegraded),
  };
};
