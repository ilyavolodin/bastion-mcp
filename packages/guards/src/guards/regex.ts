import RE2 from 're2';
import { z } from 'zod';
import { compilePathPattern } from '../paths';
import {
  ACTIONS,
  type FindingSpan,
  GUARD_PHASES,
  type Guard,
  type GuardAction,
  type GuardFinding,
  type GuardPhase,
  type TextSegment,
  type Verdict,
} from '../types';
import { REGEX_PRESETS } from './regex-presets';

/**
 * `regex` (13.4): rules compiled with RE2, so a hostile or careless pattern cannot cause catastrophic
 * backtracking. Rules carry phases, a path scope, an action and an optional `scanAppHtml` (6.8).
 */

const MAX_MATCHES_PER_RULE = 200;
const compiled = new Map<string, RE2>();

/** Compiles with RE2 (cached). Throws `SyntaxError` for patterns RE2 rejects (lookaround, backrefs). */
export const compileRe2 = (pattern: string, flags: string): RE2 => {
  const key = `${flags}/${pattern}`;
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;
  const re = new RE2(pattern, `${flags}gu`);
  if (compiled.size > 2048) compiled.clear();
  compiled.set(key, re);
  return re;
};

/** Every match of `re` in `text` as `[start, end)` offsets, bounded by `limit`. */
export const matchAllRanges = (
  re: RE2,
  text: string,
  limit = MAX_MATCHES_PER_RULE,
): { start: number; end: number; value: string }[] => {
  const out: { start: number; end: number; value: string }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null && out.length < limit; m = re.exec(text)) {
    const value = m[0];
    if (value.length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + value.length, value });
  }
  re.lastIndex = 0;
  return out;
};

const phaseSchema = z.enum(GUARD_PHASES);
const actionSchema = z.enum(ACTIONS);

export const regexRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  pattern: z.string().min(1).max(4096),
  flags: z
    .string()
    .regex(/^[imsu]*$/, 'flags may contain i, m, s, u')
    .default(''),
  phases: z
    .array(phaseSchema)
    .min(1)
    .default([...GUARD_PHASES]),
  /** `arguments.*`, `content[*].text`, `structuredContent.**` */
  paths: z.array(z.string().min(1)).min(1).default(['**']),
  action: actionSchema.default('warn'),
  verdict: z.enum(['suspicious', 'malicious']).default('suspicious'),
  scanAppHtml: z.boolean().default(false),
});
export type RegexRule = z.infer<typeof regexRuleSchema>;

const presetOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  disabledRules: z.array(z.string()).default([]),
  actions: z.partialRecord(phaseSchema, actionSchema).default({}),
});

export const regexConfigSchema = z
  .object({
    presets: z.record(z.string(), z.union([z.boolean(), presetOptionsSchema])).default({}),
    rules: z.array(regexRuleSchema).default([]),
  })
  .superRefine((config, ctx) => {
    for (const name of Object.keys(config.presets)) {
      if (!Object.hasOwn(REGEX_PRESETS, name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presets', name],
          message: `unknown preset ${name}`,
        });
      }
    }
    config.rules.forEach((rule, i) => {
      try {
        compileRe2(rule.pattern, rule.flags);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'pattern'],
          message: `pattern is not valid RE2: ${error instanceof Error ? error.message : 'error'}`,
        });
      }
      for (const p of rule.paths) {
        try {
          compilePathPattern(p);
        } catch {
          ctx.addIssue({ code: 'custom', path: ['rules', i, 'paths'], message: `bad path ${p}` });
        }
      }
    });
  });
export type RegexConfig = z.infer<typeof regexConfigSchema>;

type CompiledRule = {
  id: string;
  label: string;
  re: RE2;
  actions: Readonly<Record<GuardPhase, GuardAction>>;
  verdict: Verdict;
  category: 'sensitive-data' | 'injection' | undefined;
  scanAppHtml: boolean;
  hints: readonly string[] | undefined;
  matchesPath: ((path: string) => boolean) | undefined;
};

const ruleCache = new WeakMap<RegexConfig, CompiledRule[]>();

const compileConfig = (config: RegexConfig): CompiledRule[] => {
  const hit = ruleCache.get(config);
  if (hit !== undefined) return hit;
  const rules: CompiledRule[] = [];
  for (const [name, raw] of Object.entries(config.presets)) {
    const preset = REGEX_PRESETS[name];
    if (preset === undefined) continue;
    const opts = typeof raw === 'boolean' ? presetOptionsSchema.parse({ enabled: raw }) : raw;
    if (!opts.enabled) continue;
    const actions = { ...preset.defaultActions, ...opts.actions };
    for (const r of preset.rules) {
      if (opts.disabledRules.includes(r.id)) continue;
      rules.push({
        id: r.id,
        label: r.label,
        re: compileRe2(r.pattern, r.flags),
        actions,
        verdict: preset.verdict,
        category: preset.category,
        scanAppHtml: false,
        hints: r.hints,
        matchesPath: undefined,
      });
    }
  }
  for (const r of config.rules) {
    const matchers = r.paths.includes('**') ? undefined : r.paths.map(compilePathPattern);
    const actions: Record<GuardPhase, GuardAction> = {
      request: 'allow',
      response: 'allow',
      definition: 'allow',
    };
    for (const phase of r.phases) actions[phase] = r.action;
    rules.push({
      id: r.id,
      label: r.label ?? r.id,
      re: compileRe2(r.pattern, r.flags),
      actions,
      verdict: r.verdict,
      category: undefined,
      scanAppHtml: r.scanAppHtml,
      hints: undefined,
      matchesPath: matchers === undefined ? undefined : (p) => matchers.some((m) => m(p)),
    });
  }
  ruleCache.set(config, rules);
  return rules;
};

const hasHint = (lower: string, hints: readonly string[] | undefined): boolean =>
  hints === undefined || hints.some((h) => lower.includes(h));

export const regexGuard: Guard<RegexConfig> = {
  type: 'regex',
  configSchema: regexConfigSchema,
  async evaluate(input, config) {
    const rules = compileConfig(config).filter((r) => r.actions[input.phase] !== 'allow');
    if (rules.length === 0) return [];
    const spansByRule = new Map<CompiledRule, FindingSpan[]>();
    input.segments.forEach((seg: TextSegment, segment) => {
      if (seg.text === '') return;
      let lower: string | undefined;
      for (const rule of rules) {
        if (seg.appHtml === true && !rule.scanAppHtml) continue;
        if (rule.matchesPath !== undefined && !rule.matchesPath(seg.path)) continue;
        if (rule.hints !== undefined) {
          lower ??= seg.text.toLowerCase();
          if (!hasHint(lower, rule.hints)) continue;
        }
        const ranges = matchAllRanges(rule.re, seg.text);
        if (ranges.length === 0) continue;
        const list = spansByRule.get(rule) ?? [];
        for (const r of ranges) list.push({ segment, start: r.start, end: r.end });
        spansByRule.set(rule, list);
      }
    });
    const findings: GuardFinding[] = [];
    for (const [rule, spans] of spansByRule) {
      findings.push({
        verdict: rule.verdict,
        label: rule.label,
        ruleId: rule.id,
        spans,
        action: rule.actions[input.phase],
        ...(rule.category === undefined ? {} : { category: rule.category }),
        reason: `matched rule ${rule.id}`,
      });
    }
    return findings;
  },
};
