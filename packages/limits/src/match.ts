import picomatch from 'picomatch';
import type { Metric, Rule } from './rules';

/** Who is calling (the subjects a rule can attach to, 14.1). */
export type Principal = {
  orgId: string;
  userId?: string;
  serviceAccountId?: string;
  teamIds?: readonly string[];
  roleIds?: readonly string[];
  /** OAuth client id. */
  clientId?: string;
};

/** What the endpoint exposes; used to drop rules scoped to things the caller cannot reach. */
export type EndpointInfo = {
  installationIds?: readonly string[];
  catalogEntryIds?: readonly string[];
};

/** One MCP operation as seen by the limiter. */
export type OperationContext = {
  principal: Principal;
  method: string;
  installationId?: string;
  catalogEntryId?: string;
  /** Namespaced tool name for `tools/call`. */
  toolName?: string;
  /** Amounts for non-`calls` metrics, for example `{ samplingRequests: 1 }`. */
  amounts?: Partial<Record<Metric, number>>;
};

const globCache = new Map<string, (input: string) => boolean>();
const globMatcher = (glob: string): ((input: string) => boolean) => {
  let matcher = globCache.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, { dot: true });
    globCache.set(glob, matcher);
  }
  return matcher;
};

/** Counter subject ids a rule produces for a principal; empty when the rule does not apply to it (14.1). */
export const subjectIdsFor = (
  rule: Pick<Rule, 'subject' | 'subjectMatch'>,
  principal: Principal,
): string[] => {
  let candidates: readonly string[];
  switch (rule.subject) {
    case 'user':
      candidates = principal.userId ? [principal.userId] : [];
      break;
    case 'serviceAccount':
      candidates = principal.serviceAccountId ? [principal.serviceAccountId] : [];
      break;
    case 'team':
      candidates = principal.teamIds ?? [];
      break;
    case 'role':
      candidates = principal.roleIds ?? [];
      break;
    case 'client':
      candidates = principal.clientId ? [principal.clientId] : [];
      break;
    case 'org':
      candidates = [principal.orgId];
      break;
  }
  const match = rule.subjectMatch;
  const selected = match === 'each' ? candidates : candidates.filter((id) => match.includes(id));
  return [...new Set(selected)].sort();
};

/** The counter subject of a rule for a principal (first match when several teams or roles apply). */
export const subjectIdFor = (
  rule: Pick<Rule, 'subject' | 'subjectMatch'>,
  principal: Principal,
): string | undefined => subjectIdsFor(rule, principal)[0];

/** Selects the rules that can match this caller on this endpoint; workers evaluate only these (14.1). */
export const compileRulesFor = (
  principal: Principal,
  endpoint: EndpointInfo,
  rules: readonly Rule[],
): Rule[] =>
  rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (subjectIdsFor(rule, principal).length === 0) return false;
    const { installationId, catalogEntryId } = rule.scope;
    if (installationId && !endpoint.installationIds?.includes(installationId)) return false;
    if (catalogEntryId && !endpoint.catalogEntryIds?.includes(catalogEntryId)) return false;
    return true;
  });

/** Points a call costs under a rule: tool weight for `calls`, the supplied amount for other metrics. */
export const pointsFor = (rule: Rule, op: OperationContext): number => {
  if (rule.metric === 'calls') {
    const weight = op.toolName ? rule.cost?.[op.toolName] : undefined;
    return weight ?? 1;
  }
  return Math.ceil(op.amounts?.[rule.metric] ?? 0);
};

/** True when the rule's scope and metric apply to this operation (the subject is resolved separately). */
export const matchRule = (rule: Rule, op: OperationContext): boolean => {
  if (!rule.enabled) return false;
  const { installationId, catalogEntryId, tool, method } = rule.scope;
  if (installationId && installationId !== op.installationId) return false;
  if (catalogEntryId && catalogEntryId !== op.catalogEntryId) return false;
  if (method && method !== op.method) return false;
  if (tool && !(op.toolName && globMatcher(tool)(op.toolName))) return false;
  return pointsFor(rule, op) > 0;
};
