import type { PolicyEffect, Schemas } from '@/api/schema';
import type { RuleWhat, RuleWhen, RuleWho } from '@/api/views/access';

export type PolicyRule = Schemas['PolicyRule'];

/** Rules are evaluated in priority order; a new rule starts in the middle of the usual range. */
export const DEFAULT_RULE_PRIORITY = 100;
/** The working day the "Set hours" picker starts from: 08:00 to 19:00. */
export const DEFAULT_HOURS_FROM = 8;
export const DEFAULT_HOURS_TO = 19;

/** What the rule form edits; the inputs that only build a chip (a pattern being typed) are not part of it. */
export type RuleDraft = {
  name: string;
  /** Text of the number input. */
  priority: string;
  /** The owning team, or `''` for the whole org. */
  ownerTeamId: string;
  effect: PolicyEffect;
  who: RuleWho;
  what: RuleWhat;
  when: RuleWhen;
};

/** The form of a rule, or the form of a new one (a forbid rule for everyone, everywhere). */
export const ruleDraftOf = (rule: PolicyRule | null): RuleDraft => ({
  name: rule?.name ?? '',
  priority: String(rule?.priority ?? DEFAULT_RULE_PRIORITY),
  ownerTeamId: rule?.ownerTeamId ?? '',
  effect: rule?.effect ?? 'forbid',
  who: rule?.who ?? {},
  what: rule?.what ?? {},
  when: rule?.when ?? {},
});
