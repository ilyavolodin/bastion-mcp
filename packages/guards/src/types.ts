import { DRIFT_POLICIES, type ITEM_KINDS } from '@bastion-mcp/core';
import { z } from 'zod';

/** Guard pipeline types (13.1). */

export const GUARD_PHASES = ['request', 'response', 'definition'] as const;
export type GuardPhase = (typeof GUARD_PHASES)[number];

export const VERDICTS = ['clean', 'suspicious', 'malicious'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Ordered from least to most severe (13.2). */
export const ACTIONS = ['allow', 'warn', 'redact', 'quarantine', 'confirm', 'block'] as const;
export type GuardAction = (typeof ACTIONS)[number];

export const GUARD_TYPES = [
  'unicode',
  'size',
  'regex',
  'pii',
  'url',
  'classifier',
  'jev',
  'llmJudge',
] as const;
export type GuardType = (typeof GUARD_TYPES)[number];

/** Guards that send content to a model (13.5): off by default, run in parallel under a budget. */
export const MODEL_GUARD_TYPES: readonly string[] = ['classifier', 'jev', 'llmJudge'];

export const DEFAULT_LATENCY_BUDGET_MS = 1500;
export const DEFAULT_MAX_SCAN_BYTES = 256 * 1024;

export type PrincipalRef = { principalId: string; clientId?: string };
export type InstallationRef = { installationId: string; slug?: string };
export type ItemRef = {
  kind: (typeof ITEM_KINDS)[number] | 'file';
  name: string;
  /** Tool annotations used by session-risk escalation (13.7). */
  destructive?: boolean;
  openWorld?: boolean;
};

export type TextSegment = {
  /** Path-addressed location, for example `content[2].text` or `arguments.query` (13.3). */
  path: string;
  text: string;
  /** Block type or MIME type, matched by the `contentTypes` filter. */
  contentType?: string;
  /** Size of the original content when it is not text (binary blocks) or was masked. */
  byteLength?: number;
  /** An MCP Apps HTML body: skipped except by regex rules with `scanAppHtml` (6.8). */
  appHtml?: boolean;
};

export type FindingSpan = { segment: number; start: number; end: number };

export type FindingCategory =
  | 'injection'
  | 'invisible-text'
  | 'sensitive-data'
  | 'policy'
  | 'error';

export type GuardFinding = {
  verdict: Verdict;
  score?: number;
  label: string;
  spans?: FindingSpan[];
  reason?: string;
  /** Rule that fired (regex rule id, pii entity, ...). Goes into GUARD_BLOCKED `data.ruleId`. */
  ruleId?: string;
  /** Action the guard itself proposes; the instance `actions` map overrides it. */
  action?: GuardAction;
  /** Redaction removes the span instead of replacing it with `[REDACTED:<label>]`. */
  strip?: boolean;
  category?: FindingCategory;
  /** Model version, question and state digest for the call log (13.5). Never contains content. */
  details?: Record<string, unknown>;
  /** The guard failed; the pipeline applies the instance `failMode`. */
  error?: boolean;
};

export type GuardInput = {
  phase: GuardPhase;
  segments: TextSegment[];
  principal: PrincipalRef;
  installation: InstallationRef;
  item: ItemRef;
  method: string;
  /** Set by the pipeline; used for the model-guard cache key. */
  instanceId?: string;
};

export interface Guard<C> {
  type: string;
  configSchema: z.ZodType<C>;
  evaluate(input: GuardInput, config: C, signal: AbortSignal): Promise<GuardFinding[]>;
}

/** A guard whose config is validated by the pipeline from raw JSON. */
export interface RegisteredGuard {
  type: string;
  parseConfig(raw: unknown): unknown;
  evaluate(input: GuardInput, parsedConfig: unknown, signal: AbortSignal): Promise<GuardFinding[]>;
}

/** Adapts a typed guard to the registry: config is parsed from JSON once per instance. */
export const defineGuard = <C>(guard: Guard<C>): RegisteredGuard => ({
  type: guard.type,
  parseConfig: (raw) => guard.configSchema.parse(raw),
  // The pipeline only ever passes the output of `parseConfig`, which is a `C`.
  evaluate: (input, parsed, signal) => guard.evaluate(input, parsed as C, signal),
});

// --- Profile schema ------------------------------------------------------------------------------------------

const actionSchema = z.enum(ACTIONS);

export const guardInstanceSchema = z.object({
  instanceId: z.string().min(1),
  type: z.enum(GUARD_TYPES),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Action per verdict; overrides the action a guard proposes. */
  actions: z
    .object({
      clean: actionSchema.optional(),
      suspicious: actionSchema.optional(),
      malicious: actionSchema.optional(),
    })
    .default({}),
  failMode: z.enum(['open', 'closed']).default('open'),
  mode: z.enum(['blocking', 'async']).default('blocking'),
  filters: z
    .object({
      phases: z.array(z.enum(GUARD_PHASES)).min(1).optional(),
      installations: z.array(z.string()).min(1).optional(),
      /** picomatch globs over the item name. */
      tools: z.array(z.string()).min(1).optional(),
      contentTypes: z.array(z.string()).min(1).optional(),
    })
    .default({}),
});
export type GuardInstance = z.infer<typeof guardInstanceSchema>;
export type GuardInstanceInput = z.input<typeof guardInstanceSchema>;

export const guardProfileSchema = z.object({
  profileId: z.string().min(1).optional(),
  guards: z.array(guardInstanceSchema),
  latencyBudgetMs: z.number().int().min(1).max(60_000).default(DEFAULT_LATENCY_BUDGET_MS),
  maxScanBytes: z.number().int().min(1).default(DEFAULT_MAX_SCAN_BYTES),
  onOversize: z.enum(['scanPrefix', 'block']).default('scanPrefix'),
  onDrift: z.enum(DRIFT_POLICIES).default('hideChanged'),
  riskEscalation: z
    .object({
      enabled: z.boolean().default(true),
      threshold: z.number().positive().default(5),
      action: z.enum(['confirm', 'block']).default('confirm'),
    })
    .default({ enabled: true, threshold: 5, action: 'confirm' }),
});
export type GuardProfile = z.infer<typeof guardProfileSchema>;
export type GuardProfileInput = z.input<typeof guardProfileSchema>;

// --- Ports (13.8, 13.7, 15.3) --------------------------------------------------------------------------------

/** Model-guard result cache; adapters store under `redisKeys.guardCache` keys with the given TTL. */
export interface GuardCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export type RiskState = { score: number; updatedAt: number };

/** Session risk store, keyed like `redisKeys.risk(principalId, clientId)`; TTL is `TTL.riskScore`. */
export interface RiskStore {
  get(principalId: string, clientId: string): Promise<RiskState | null>;
  set(principalId: string, clientId: string, state: RiskState): Promise<void>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface Metrics {
  /** `bastion.guard.evaluations` counter (15.3). */
  evaluation(attrs: {
    guard: string;
    phase: GuardPhase;
    verdict: Verdict | 'error';
    action: GuardAction;
  }): void;
  /** `bastion.guard.duration` histogram, seconds. */
  duration(attrs: { guard: string }, seconds: number): void;
}

export interface SecretResolver {
  /** Resolve an org secret name to its value. Rejects when the secret does not exist. */
  resolve(name: string): Promise<string>;
}

export type FetchResponseLike = { ok: boolean; status: number; json(): Promise<unknown> };
export type FetchInit = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};
/** Structurally compatible with the global `fetch` and with `undici.fetch`. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

/** Raised by guards that cannot evaluate (timeout, HTTP error, invalid response). */
export class GuardError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GuardError';
    this.reason = reason;
  }
}
