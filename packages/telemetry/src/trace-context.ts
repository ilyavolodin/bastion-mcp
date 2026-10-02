/**
 * W3C trace context for MCP (15.2, 6.4): the downstream parent comes from `params._meta.traceparent`
 * (SEP-414) when present, otherwise from the HTTP `traceparent` header. Upstream requests carry the
 * context both ways.
 */
import {
  type Context,
  context,
  ROOT_CONTEXT,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

export type HeaderBag = Record<string, string | string[] | undefined>;
export type MetaBag = Record<string, unknown>;

const propagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

const KEYS = ['traceparent', 'tracestate', 'baggage'] as const;

const asString = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v)) {
    const joined = v.filter((x): x is string => typeof x === 'string').join(',');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
};

const getter: TextMapGetter<Record<string, string>> = {
  keys: (c) => Object.keys(c),
  get: (c, key) => c[key],
};

const setter: TextMapSetter<Record<string, string>> = {
  set: (c, key, value) => {
    c[key] = value;
  },
};

/** The carrier `{traceparent, tracestate, baggage}` chosen by 15.2: `_meta` first, headers as fallback. */
export const selectTraceCarrier = (
  meta: MetaBag | undefined,
  headers: HeaderBag | undefined,
): Record<string, string> => {
  const pick = (source: (k: string) => unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const key of KEYS) {
      const value = asString(source(key));
      if (value !== undefined) out[key] = value;
    }
    return out;
  };
  const fromMeta = pick((k) => meta?.[k]);
  if (fromMeta.traceparent !== undefined) return fromMeta;
  return pick((k) => headers?.[k] ?? headers?.[k.toUpperCase()]);
};

/** Extract the parent context for a downstream request (15.2). */
export const extractTraceContext = (
  meta: MetaBag | undefined,
  headers: HeaderBag | undefined,
  base: Context = ROOT_CONTEXT,
): Context => propagator.extract(base, selectTraceCarrier(meta, headers), getter);

/**
 * Inject the active (or given) context into both the JSON-RPC `_meta` object and the HTTP headers of an
 * upstream request (6.4). Both objects are mutated.
 */
export const injectTraceContext = (
  meta: MetaBag,
  headers: Record<string, string>,
  ctx: Context = context.active(),
): void => {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, setter);
  for (const [key, value] of Object.entries(carrier)) {
    meta[key] = value;
    headers[key] = value;
  }
};
