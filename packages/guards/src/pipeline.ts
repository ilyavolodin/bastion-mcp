import { GuardBlockedError, META_KEYS, MS, TtlCache } from '@bastion-mcp/core';
import picomatch from 'picomatch';
import { mostSevere, resolveAction } from './actions';
import { limitSegmentsToBytes, maskSegments, totalTextBytes } from './extract';
import {
  decayedScore,
  isEscalationTarget,
  loadRisk,
  RISK_ESCALATION_THRESHOLD,
  recordRisk,
  riskDelta,
} from './risk';
import {
  type Clock,
  DEFAULT_LATENCY_BUDGET_MS,
  type FindingCategory,
  type GuardAction,
  GuardError,
  type GuardFinding,
  type GuardInput,
  type GuardInstance,
  type GuardPhase,
  type GuardProfile,
  type GuardProfileInput,
  guardProfileSchema,
  type Metrics,
  MODEL_GUARD_TYPES,
  type RegisteredGuard,
  type RiskStore,
  VERDICTS,
  type Verdict,
} from './types';

/** Guard pipeline (13.1, 13.7, 13.8). */

/** Cost order (13.1): cheap deterministic guards first, model guards last. */
export const COST_ORDER = [
  'unicode',
  'size',
  'regex',
  'pii',
  'url',
  'classifier',
  'jev',
  'llmJudge',
] as const;

export type ProfileLayers = {
  org?: GuardProfileInput | GuardProfile | undefined;
  catalogVersion?: GuardProfileInput | GuardProfile | undefined;
  tool?: GuardProfileInput | GuardProfile | undefined;
};

export type PipelineInput = Omit<GuardInput, 'instanceId'>;

/** One row of the call log's `guard_results` (13.8). */
export type GuardResultRecord = {
  guard: string;
  type: string;
  phase: GuardPhase;
  verdict: Verdict | 'error';
  score?: number;
  action: GuardAction;
  latencyMs: number;
  modelVersion?: string;
  mode: 'blocking' | 'async';
  /** Failure reason for `guard_error` records. */
  error?: string;
};

export type ResolvedFinding = {
  guard: string;
  type: string;
  finding: GuardFinding;
  action: GuardAction;
};

export type GuardRunResult = {
  /** The most severe action across all findings (13.2). */
  action: GuardAction;
  block?: { guard: string; ruleId: string; label: string; reason?: string };
  confirm?: { guard: string; reason: string };
  findings: ResolvedFinding[];
  /** Findings whose action is `redact`; hand to `applyRedactions`. All of them apply (13.2). */
  redactions: GuardFinding[];
  quarantine?: { guard: string; score?: number; segments: number[] };
  records: GuardResultRecord[];
  /** The principal's decayed risk score before this evaluation, when a risk store is configured. */
  riskScore?: number;
  /** Model guards skipped because the text exceeded `maxScanBytes` (`scanPrefix`). */
  truncated: boolean;
  /** Settles after async guards have run and `onAsync` has been called. */
  asyncSettled: Promise<void>;
};

export type AsyncGuardResult = {
  input: PipelineInput;
  findings: ResolvedFinding[];
  records: GuardResultRecord[];
};

export type PipelineDeps = {
  guards: readonly RegisteredGuard[];
  clock: Clock;
  /** Monotonic milliseconds for latency records; defaults to `performance.now`. */
  timer?: () => number;
  metrics?: Metrics;
  riskStore?: RiskStore;
  /** Called after the response has been sent, with the findings of `async` guards (13.1). */
  onAsync?: (result: AsyncGuardResult) => void | Promise<void>;
};

const profileCache = new WeakMap<object, GuardProfile>();
const parseProfile = (p: GuardProfileInput | GuardProfile): GuardProfile => {
  const hit = profileCache.get(p);
  if (hit !== undefined) return hit;
  const parsed = guardProfileSchema.parse(p);
  profileCache.set(p, parsed);
  return parsed;
};

export type EffectiveProfile = {
  guards: GuardInstance[];
  latencyBudgetMs: number;
  maxScanBytes: number;
  onOversize: 'scanPrefix' | 'block';
  riskEscalation: { enabled: boolean; threshold: number; action: 'confirm' | 'block' };
};

/**
 * The effective guards: org default, then catalog version, then tool-level profile, deduplicated by
 * instance id. The first layer that defines an instance wins, so a narrower layer can add guards but can
 * never weaken one set by a wider layer (24.2). Budget and scan limits take the strictest value.
 */
export const mergeProfiles = (layers: ProfileLayers): EffectiveProfile => {
  const ordered = [layers.org, layers.catalogVersion, layers.tool]
    .filter((p): p is GuardProfileInput | GuardProfile => p !== undefined)
    .map(parseProfile);
  const seen = new Set<string>();
  const guards: GuardInstance[] = [];
  for (const profile of ordered) {
    for (const g of profile.guards) {
      if (seen.has(g.instanceId)) continue;
      seen.add(g.instanceId);
      guards.push(g);
    }
  }
  const enabled = ordered.filter((p) => p.riskEscalation.enabled);
  return {
    guards,
    latencyBudgetMs: Math.min(...ordered.map((p) => p.latencyBudgetMs), DEFAULT_LATENCY_BUDGET_MS),
    maxScanBytes: Math.min(...ordered.map((p) => p.maxScanBytes), Number.MAX_SAFE_INTEGER),
    onOversize: ordered.some((p) => p.onOversize === 'block') ? 'block' : 'scanPrefix',
    riskEscalation: {
      enabled: enabled.length > 0,
      threshold: Math.min(
        ...enabled.map((p) => p.riskEscalation.threshold),
        RISK_ESCALATION_THRESHOLD * 100,
      ),
      action: enabled.some((p) => p.riskEscalation.action === 'block') ? 'block' : 'confirm',
    },
  };
};

const costRank = (type: string): number => {
  const i = (COST_ORDER as readonly string[]).indexOf(type);
  return i < 0 ? COST_ORDER.length : i;
};

const MATCHER_CACHE_MAX = 1024;

type Matcher = (s: string) => boolean;

/** Compiled glob matchers, bounded and owned by one pipeline. */
class MatcherCache {
  private readonly cache = new TtlCache<string, Matcher>({ ttlMs: MS.DAY, max: MATCHER_CACHE_MAX });

  get(globs: readonly string[], nocase = false): Matcher {
    const key = `${nocase ? 'i' : 's'}:${globs.join('\u0000')}`;
    let m = this.cache.get(key);
    if (m === undefined) {
      m = picomatch([...globs], { nocase, dot: true });
      this.cache.set(key, m);
    }
    return m;
  }
}

const appliesTo = (g: GuardInstance, input: PipelineInput, matchers: MatcherCache): boolean => {
  if (!g.enabled) return false;
  const f = g.filters;
  if (f.phases !== undefined && !f.phases.includes(input.phase)) return false;
  if (
    f.installations !== undefined &&
    !f.installations.includes(input.installation.installationId) &&
    !(input.installation.slug !== undefined && f.installations.includes(input.installation.slug))
  ) {
    return false;
  }
  if (f.tools !== undefined && !matchers.get(f.tools)(input.item.name)) return false;
  return true;
};

const errorFinding = (g: GuardInstance, error: unknown): GuardFinding => {
  const reason =
    error instanceof GuardError ? error.reason : error instanceof Error ? error.name : 'error';
  return {
    verdict: 'suspicious',
    label: 'guard_error',
    ruleId: 'guard_error',
    category: 'error',
    error: true,
    action: g.failMode === 'closed' ? 'block' : 'warn',
    reason: `guard ${g.instanceId} failed: ${reason}`,
    details: { reason },
  };
};

const verdictRank = (v: Verdict): number => VERDICTS.indexOf(v);
const INJECTION_CATEGORIES: readonly (FindingCategory | undefined)[] = [
  'injection',
  'invisible-text',
];

type InstanceOutcome = { resolved: ResolvedFinding[]; record: GuardResultRecord };

/** The result of the oversize check (13.3): a block finding, or the prefix model guards will see. */
type OversizeOutcome = {
  finding?: ResolvedFinding;
  segments?: GuardInput['segments'];
  truncated: boolean;
};

/** Pure: decides what happens when the text is over `maxScanBytes`; `undefined` when it fits. */
export const oversizeOutcome = (
  segments: GuardInput['segments'],
  profile: Pick<EffectiveProfile, 'maxScanBytes' | 'onOversize'>,
): OversizeOutcome | undefined => {
  if (totalTextBytes(segments) <= profile.maxScanBytes) return undefined;
  if (profile.onOversize === 'block') {
    return {
      truncated: false,
      finding: {
        guard: 'pipeline',
        type: 'pipeline',
        action: 'block',
        finding: {
          verdict: 'malicious',
          label: 'max-scan-bytes',
          ruleId: 'max-scan-bytes',
          action: 'block',
          category: 'policy',
          reason: `content exceeds maxScanBytes (${profile.maxScanBytes})`,
        },
      },
    };
  }
  const limited = limitSegmentsToBytes(segments, profile.maxScanBytes);
  return { truncated: limited.truncated, segments: limited.segments };
};

/** Pure: the session-risk finding when the score warrants escalating this request (13.7). */
export const escalationFinding = (
  input: PipelineInput,
  esc: EffectiveProfile['riskEscalation'],
  score: number,
): ResolvedFinding | undefined => {
  if (
    !esc.enabled ||
    input.phase !== 'request' ||
    !isEscalationTarget(input.item) ||
    score < esc.threshold
  ) {
    return undefined;
  }
  return {
    guard: 'session-risk',
    type: 'session-risk',
    action: esc.action,
    finding: {
      verdict: 'suspicious',
      label: 'session-risk',
      ruleId: 'session-risk',
      action: esc.action,
      category: 'policy',
      score,
      reason: `session risk score ${score.toFixed(1)} is at or above ${esc.threshold}`,
    },
  };
};

export class GuardPipeline {
  private readonly byType: Map<string, RegisteredGuard>;
  private readonly parsedConfigs = new WeakMap<object, unknown>();
  private readonly matchers = new MatcherCache();
  private readonly now: () => number;

  constructor(private readonly deps: PipelineDeps) {
    this.byType = new Map(deps.guards.map((g) => [g.type, g]));
    this.now = deps.timer ?? (() => performance.now());
  }

  /**
   * Evaluates the effective guards for one operation. Deterministic guards run sequentially in cost order,
   * blocking model guards in parallel inside `latencyBudgetMs`, `async` guards after this call returns.
   */
  async run(
    input: PipelineInput,
    layers: ProfileLayers,
    options: { signal?: AbortSignal } = {},
  ): Promise<GuardRunResult> {
    const profile = mergeProfiles(layers);
    const applicable = profile.guards
      .filter((g) => appliesTo(g, input, this.matchers))
      .sort((a, b) => costRank(a.type) - costRank(b.type));
    const blocking = applicable.filter((g) => g.mode === 'blocking');
    const asyncGuards = applicable.filter((g) => g.mode === 'async');
    const deterministic = blocking.filter((g) => !MODEL_GUARD_TYPES.includes(g.type));
    const models = blocking.filter((g) => MODEL_GUARD_TYPES.includes(g.type));

    const resolved: ResolvedFinding[] = [];
    const records: GuardResultRecord[] = [];
    const collect = (o: InstanceOutcome): void => {
      resolved.push(...o.resolved);
      records.push(o.record);
    };

    const external = options.signal ?? new AbortController().signal;
    for (const g of deterministic) collect(await this.evaluate(g, input, input.segments, external));

    // Oversize content (13.3): model guards see a prefix, or the call is blocked.
    const modelGuardsPresent =
      models.length > 0 || asyncGuards.some((g) => MODEL_GUARD_TYPES.includes(g.type));
    const oversize = modelGuardsPresent ? oversizeOutcome(input.segments, profile) : undefined;
    if (oversize?.finding) resolved.push(oversize.finding);
    const truncated = oversize?.truncated ?? false;
    const modelSegments = oversize?.segments ?? input.segments;

    // A deterministic block already decides the outcome: nothing leaves for a model (13.5).
    const alreadyBlocked = resolved.some((r) => r.action === 'block');
    if (models.length > 0 && !alreadyBlocked) {
      const outcomes = await this.runWithinBudget(
        models,
        input,
        modelSegments,
        profile.latencyBudgetMs,
        external,
      );
      for (const o of outcomes) collect(o);
    }

    // Session risk (13.7).
    const risk = await this.sessionRisk(input, profile, records, resolved);
    if (risk?.finding) resolved.push(risk.finding);
    const riskScore = risk?.score;

    const result = this.assemble(input, resolved, records, truncated, riskScore);
    result.asyncSettled = this.runAsync(asyncGuards, input, modelSegments, profile, external);
    return result;
  }

  /** Runs guards in parallel; each one that outlives `budgetMs` fails with a `timeout` finding. */
  private async runWithinBudget(
    guards: readonly GuardInstance[],
    input: PipelineInput,
    segments: GuardInput['segments'],
    budgetMs: number,
    external: AbortSignal,
  ): Promise<InstanceOutcome[]> {
    const budget = new AbortController();
    const timer = setTimeout(() => {
      budget.abort();
    }, budgetMs);
    const signal = AbortSignal.any([budget.signal, external]);
    try {
      return await Promise.all(
        guards.map((g) => this.evaluateWithin(g, input, segments, signal, budget.signal)),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads the principal's decayed risk score, escalates when it is over the threshold (13.7), and records
   * this evaluation's delta. `undefined` when no risk store or client id is available.
   */
  private async sessionRisk(
    input: PipelineInput,
    profile: EffectiveProfile,
    records: readonly GuardResultRecord[],
    resolved: readonly ResolvedFinding[],
  ): Promise<{ score: number; finding?: ResolvedFinding } | undefined> {
    const { riskStore } = this.deps;
    const clientId = input.principal.clientId;
    if (riskStore === undefined || clientId === undefined) return undefined;
    const state = await loadRisk(riskStore, input.principal.principalId, clientId);
    const score = decayedScore(state, this.deps.clock.now());
    const finding = escalationFinding(input, profile.riskEscalation, score);
    const all = finding === undefined ? resolved : [...resolved, finding];
    await recordRisk(
      riskStore,
      input.principal.principalId,
      clientId,
      this.deltaOf(records, all),
      this.deps.clock.now(),
    );
    return finding === undefined ? { score } : { score, finding };
  }

  private deltaOf(
    records: readonly GuardResultRecord[],
    resolved: readonly ResolvedFinding[],
  ): number {
    const verdicts: Verdict[] = [];
    for (const rec of records) {
      let worst: Verdict = 'clean';
      for (const r of resolved) {
        if (r.guard !== rec.guard || !INJECTION_CATEGORIES.includes(r.finding.category)) continue;
        if (verdictRank(r.finding.verdict) > verdictRank(worst)) worst = r.finding.verdict;
      }
      verdicts.push(worst);
    }
    return riskDelta(verdicts);
  }

  private assemble(
    input: PipelineInput,
    resolved: ResolvedFinding[],
    records: GuardResultRecord[],
    truncated: boolean,
    riskScore: number | undefined,
  ): GuardRunResult {
    const action = mostSevere(resolved.map((r) => r.action));
    const result: GuardRunResult = {
      action,
      findings: resolved.filter((r) => r.finding.verdict !== 'clean' || r.action !== 'allow'),
      redactions: resolved.filter((r) => r.action === 'redact').map((r) => r.finding),
      records,
      truncated,
      asyncSettled: Promise.resolve(),
    };
    if (riskScore !== undefined) result.riskScore = riskScore;
    const blocker = resolved.find((r) => r.action === 'block');
    if (blocker !== undefined) {
      result.block = {
        guard: blocker.guard,
        ruleId: blocker.finding.ruleId ?? blocker.finding.label,
        label: blocker.finding.label,
        ...(blocker.finding.reason === undefined ? {} : { reason: blocker.finding.reason }),
      };
    }
    const confirmer = resolved.find((r) => r.action === 'confirm');
    if (confirmer !== undefined) {
      result.confirm = {
        guard: confirmer.guard,
        reason: confirmer.finding.reason ?? `${confirmer.finding.label} requires approval`,
      };
    }
    const quarantined = resolved.filter((r) => r.action === 'quarantine');
    if (quarantined.length > 0) {
      const segments = new Set<number>();
      for (const q of quarantined) {
        const spans = q.finding.spans;
        if (spans === undefined || spans.length === 0) {
          input.segments.forEach((s, i) => {
            if (s.text !== '') segments.add(i);
          });
        } else {
          for (const s of spans) segments.add(s.segment);
        }
      }
      const top = quarantined.reduce((a, b) =>
        (b.finding.score ?? 0) > (a.finding.score ?? 0) ? b : a,
      );
      result.quarantine = {
        guard: top.guard,
        segments: [...segments].sort((a, b) => a - b),
        ...(top.finding.score === undefined ? {} : { score: top.finding.score }),
      };
    }
    return result;
  }

  private runAsync(
    guards: readonly GuardInstance[],
    input: PipelineInput,
    segments: GuardInput['segments'],
    profile: EffectiveProfile,
    external: AbortSignal,
  ): Promise<void> {
    if (guards.length === 0) return Promise.resolve();
    return (async () => {
      await Promise.resolve(); // after the response is on its way
      try {
        const outcomes = await this.runWithinBudget(
          guards,
          input,
          segments,
          profile.latencyBudgetMs,
          external,
        );
        const findings = outcomes.flatMap((o) => o.resolved);
        const records = outcomes.map((o) => o.record);
        const { riskStore } = this.deps;
        const clientId = input.principal.clientId;
        if (riskStore !== undefined && clientId !== undefined) {
          await recordRisk(
            riskStore,
            input.principal.principalId,
            clientId,
            this.deltaOf(records, findings),
            this.deps.clock.now(),
          );
        }
        await this.deps.onAsync?.({ input, findings, records });
      } catch {
        // Async evaluation is best effort and never affects the call.
      }
    })();
  }

  private parsedConfig(guard: RegisteredGuard, instance: GuardInstance): unknown {
    const hit = this.parsedConfigs.get(instance);
    if (hit !== undefined) return hit;
    const parsed = guard.parseConfig(instance.config);
    this.parsedConfigs.set(instance, parsed);
    return parsed;
  }

  private evaluateWithin(
    g: GuardInstance,
    input: PipelineInput,
    segments: GuardInput['segments'],
    signal: AbortSignal,
    budget: AbortSignal,
  ): Promise<InstanceOutcome> {
    const started = this.now();
    const timedOut = new Promise<InstanceOutcome>((resolve) => {
      const fire = (): void => {
        resolve(
          this.failed(g, input, new GuardError('timeout', 'latency budget exceeded'), started),
        );
      };
      if (budget.aborted) fire();
      else budget.addEventListener('abort', fire, { once: true });
    });
    return Promise.race([this.evaluate(g, input, segments, signal), timedOut]);
  }

  private failed(
    g: GuardInstance,
    input: PipelineInput,
    error: unknown,
    started: number,
  ): InstanceOutcome {
    const finding = errorFinding(g, error);
    const action = finding.action ?? 'warn';
    const record: GuardResultRecord = {
      guard: g.instanceId,
      type: g.type,
      phase: input.phase,
      verdict: 'error',
      action,
      latencyMs: this.now() - started,
      mode: g.mode,
      error: typeof finding.details?.reason === 'string' ? finding.details.reason : 'error',
    };
    this.observe(record);
    return { resolved: [{ guard: g.instanceId, type: g.type, finding, action }], record };
  }

  private observe(record: GuardResultRecord): void {
    const { metrics } = this.deps;
    if (metrics === undefined) return;
    try {
      metrics.evaluation({
        guard: record.guard,
        phase: record.phase,
        verdict: record.verdict,
        action: record.action,
      });
      metrics.duration({ guard: record.guard }, record.latencyMs / 1000);
    } catch {
      // Telemetry never breaks a call.
    }
  }

  private async evaluate(
    g: GuardInstance,
    input: PipelineInput,
    segments: GuardInput['segments'],
    signal: AbortSignal,
  ): Promise<InstanceOutcome> {
    const started = this.now();
    const guard = this.byType.get(g.type);
    if (guard === undefined) {
      return this.failed(
        g,
        input,
        new GuardError('unknown_guard', `no guard of type ${g.type}`),
        started,
      );
    }
    try {
      const config = this.parsedConfig(guard, g);
      const masked = this.maskFor(g, segments);
      const findings = await guard.evaluate(
        { ...input, segments: masked, instanceId: g.instanceId },
        config,
        signal,
      );
      const resolved: ResolvedFinding[] = [];
      for (const finding of findings) {
        if (finding.error === true) {
          const err = errorFinding(g, new GuardError('error', finding.reason ?? 'error'));
          resolved.push({
            guard: g.instanceId,
            type: g.type,
            finding: err,
            action: err.action ?? 'warn',
          });
          continue;
        }
        resolved.push({
          guard: g.instanceId,
          type: g.type,
          finding,
          action: resolveAction(finding, g.actions),
        });
      }
      const worst = findings.reduce<Verdict>(
        (acc, f) => (verdictRank(f.verdict) > verdictRank(acc) ? f.verdict : acc),
        'clean',
      );
      const scores = findings.map((f) => f.score).filter((s): s is number => s !== undefined);
      const version = findings
        .map((f) => f.details?.modelVersion)
        .find((v): v is string => typeof v === 'string');
      const record: GuardResultRecord = {
        guard: g.instanceId,
        type: g.type,
        phase: input.phase,
        verdict: worst,
        action: mostSevere(resolved.map((r) => r.action)),
        latencyMs: this.now() - started,
        mode: g.mode,
        ...(scores.length > 0 ? { score: Math.max(...scores) } : {}),
        ...(version === undefined ? {} : { modelVersion: version }),
      };
      this.observe(record);
      return { resolved, record };
    } catch (error) {
      return this.failed(g, input, error, started);
    }
  }

  /** Content-type filters and MCP Apps HTML (6.8) hide segments from a guard without shifting indices. */
  private maskFor(g: GuardInstance, segments: GuardInput['segments']): GuardInput['segments'] {
    const types = g.filters.contentTypes;
    const matchType = types === undefined ? undefined : this.matchers.get(types, true);
    const skipAppHtml = g.type !== 'regex';
    if (matchType === undefined && !skipAppHtml) return segments;
    return maskSegments(
      segments,
      (s) =>
        (skipAppHtml && s.appHtml === true) ||
        (matchType !== undefined && !matchType(s.contentType ?? 'text')),
    );
  }
}

// --- Helpers for callers ---------------------------------------------------------------------------------------

/** The `GUARD_BLOCKED` error for a blocked result (6.9). */
export const toGuardBlockedError = (result: GuardRunResult): GuardBlockedError => {
  const b = result.block;
  return new GuardBlockedError(
    `Blocked by security guard ${b?.guard ?? 'unknown'}: ${b?.reason ?? b?.label ?? 'policy'}.`,
    { guard: b?.guard ?? 'unknown', ruleId: b?.ruleId ?? 'unknown' },
  );
};

/** Value for `_meta["io.github.bastion-mcp/guard"]` on `warn` and other non-allow outcomes (13.2). */
export const guardMetaFor = (
  result: GuardRunResult,
): { key: string; value: Record<string, unknown> } | undefined => {
  const flagged = result.findings.filter((f) => f.action !== 'allow');
  if (flagged.length === 0) return undefined;
  return {
    key: META_KEYS.guard,
    value: {
      action: result.action,
      findings: flagged.map((f) => ({
        guard: f.guard,
        label: f.finding.label,
        verdict: f.finding.verdict,
        action: f.action,
        ...(f.finding.score === undefined ? {} : { score: f.finding.score }),
      })),
    },
  };
};
