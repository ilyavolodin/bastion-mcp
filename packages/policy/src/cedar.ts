import { isRecord } from '@bastion-mcp/core';
import type {
  DetailedError,
  EntityJson,
  EntityUidJson,
  PolicyJson,
} from '@cedar-policy/cedar-wasm/nodejs';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { PolicyEvaluationError } from './errors';
import { loadSchema, NAMESPACE } from './schema';
import type { PolicyEntry } from './types';

/** Thin typed layer over `@cedar-policy/cedar-wasm` (Node build, in-process). */
export { cedar };

export const entityKey = (type: string, id: string): string => `${type}\u0000${id}`;

const uidParts = (uid: EntityUidJson): { type: string; id: string } =>
  '__entity' in uid ? uid.__entity : uid;

const uidKey = (uid: EntityUidJson): string => {
  const { type, id } = uidParts(uid);
  return entityKey(type, id);
};

/** What a policy can match on, used to shard a large policy set so a request evaluates few policies. */
export type PolicyAnalysis = {
  /** Action ids the scope restricts to, or null when it matches every action. */
  actions: string[] | null;
  /** `entityKey` of the `==`/`in` principal anchor, or null. */
  principal: string | null;
  resource: string | null;
  /** Attributes read from `resource` in conditions. */
  resourceAttrs: ReadonlySet<string>;
  /** True when conditions use the resource entity itself (id) other than via `in`/attribute access. */
  resourceIdentity: boolean;
  /**
   * A conjunct of the conditions that tests the resource's name or uri against a literal or glob. When it is
   * false for an item the policy cannot apply to that item, so the engine leaves the policy out for it.
   */
  matcher: AttrMatcher | null;
};

export type AttrMatcher = {
  attr: 'name' | 'uri';
  /** Segments between wildcards; one segment means an exact match. */
  segments: string[];
};

/** Linear-time glob test against pre-split segments (no regular expressions, so no backtracking blowup). */
export const matchSegments = (segments: readonly string[], text: string): boolean => {
  const first = segments[0] ?? '';
  if (segments.length === 1) return text === first;
  const last = segments[segments.length - 1] ?? '';
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) {
    return false;
  }
  const end = text.length - last.length;
  let pos = first.length;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? '';
    const at = text.indexOf(segment, pos);
    if (at < 0 || at + segment.length > end) return false;
    pos = at + segment.length;
  }
  return true;
};

const isResourceAttr = (node: Json): 'name' | 'uri' | null => {
  if (!isRecord(node) || !isRecord(node['.'])) return null;
  const dot = node['.'];
  const attr = dot.attr;
  return isResourceVar(dot.left) && (attr === 'name' || attr === 'uri') ? attr : null;
};

const conjuncts = (node: Json): Json[] => {
  if (isRecord(node) && isRecord(node['&&'])) {
    return [...conjuncts(node['&&'].left), ...conjuncts(node['&&'].right)];
  }
  return [node];
};

const findMatcher = (policy: PolicyJson): AttrMatcher | null => {
  for (const clause of policy.conditions) {
    if (clause.kind !== 'when') continue;
    for (const node of conjuncts(clause.body)) {
      if (!isRecord(node)) continue;
      const eq = node['=='];
      if (isRecord(eq)) {
        const attr = isResourceAttr(eq.left);
        const right = eq.right;
        if (attr && isRecord(right) && typeof right.Value === 'string') {
          return { attr, segments: [right.Value] };
        }
      }
      const like = node.like;
      if (isRecord(like) && Array.isArray(like.pattern)) {
        const attr = isResourceAttr(like.left);
        if (!attr) continue;
        const segments = [''];
        for (const element of like.pattern as Json[]) {
          if (element === 'Wildcard') segments.push('');
          else if (isRecord(element) && typeof element.Literal === 'string') {
            segments[segments.length - 1] += element.Literal;
          }
        }
        return { attr, segments };
      }
    }
  }
  return null;
};

type Json = unknown;

const isResourceVar = (node: Json): boolean => isRecord(node) && node.Var === 'resource';

const walk = (node: Json, attrs: Set<string>, state: { identity: boolean }): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, attrs, state);
    return;
  }
  if (!isRecord(node)) return;
  if (isResourceVar(node)) {
    state.identity = true;
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if ((key === '.' || key === 'has') && isRecord(value) && isResourceVar(value.left)) {
      const attr = value.attr;
      if (typeof attr === 'string') attrs.add(attr);
      else if (Array.isArray(attr)) for (const a of attr) if (typeof a === 'string') attrs.add(a);
      continue;
    }
    if (key === 'in' && isRecord(value) && isResourceVar(value.left)) {
      walk(value.right, attrs, state);
      continue;
    }
    walk(value, attrs, state);
  }
};

const IDENTITY_TYPES = new Set([
  `${NAMESPACE}::Tool`,
  `${NAMESPACE}::Prompt`,
  `${NAMESPACE}::Resource`,
]);

const entityOf = (c: unknown): EntityUidJson | null =>
  isRecord(c) && isRecord(c.entity) ? (c.entity as EntityUidJson) : null;

const entitiesOf = (c: unknown): EntityUidJson[] => {
  if (isRecord(c) && Array.isArray(c.entities)) return c.entities as EntityUidJson[];
  const single = entityOf(c);
  return single ? [single] : [];
};

export const analyzePolicyJson = (policy: PolicyJson): PolicyAnalysis => {
  const action = policy.action;
  const actions =
    action.op === '==' || action.op === 'in' ? entitiesOf(action).map((e) => uidParts(e).id) : null;
  const anchor = (c: PolicyJson['principal'] | PolicyJson['resource']): string | null => {
    if (c.op === '==' || c.op === 'in') {
      const e = entityOf(c);
      return e ? uidKey(e) : null;
    }
    if (c.op === 'is') {
      const e = entityOf(c.in);
      return e ? uidKey(e) : null;
    }
    return null;
  };
  const attrs = new Set<string>();
  const state = { identity: false };
  for (const clause of policy.conditions) walk(clause.body, attrs, state);
  const resourceAnchor = anchor(policy.resource);
  const resourceEntity = policy.resource.op === '==' ? entityOf(policy.resource) : null;
  if (resourceEntity && IDENTITY_TYPES.has(uidParts(resourceEntity).type)) state.identity = true;
  return {
    actions,
    principal: anchor(policy.principal),
    resource: resourceAnchor,
    resourceAttrs: attrs,
    resourceIdentity: state.identity,
    matcher: findMatcher(policy),
  };
};

export const policyToJson = (text: string): PolicyJson => {
  const result = cedar.policyToJson(text);
  if (result.type !== 'success') {
    throw new PolicyEvaluationError('Policy does not parse', {
      errors: formatErrors(result.errors),
    });
  }
  return result.json;
};

export const formatErrors = (errors: readonly DetailedError[]): string[] =>
  errors.map((e) => (e.help ? `${e.message} (${e.help})` : e.message));

/** Splits Cedar text into single policies, keyed by their `@id` annotation (or `<fallback>.<n>`). */
export const splitPolicies = (text: string, fallbackPrefix: string): PolicyEntry[] => {
  const parts = cedar.policySetTextToParts(text);
  if (parts.type !== 'success') {
    throw new PolicyEvaluationError('Policy text does not parse', {
      errors: formatErrors(parts.errors),
    });
  }
  if (parts.policy_templates.length > 0) {
    throw new PolicyEvaluationError('Policy templates are not supported');
  }
  const seen = new Set<string>();
  return parts.policies.map((policyText, index) => {
    const annotated = policyToJson(policyText).annotations?.id;
    let id = annotated ?? `${fallbackPrefix}.${index}`;
    if (seen.has(id)) id = `${id}#${index}`;
    seen.add(id);
    return { id, text: policyText };
  });
};

export type ValidationOutcome = { ok: true } | { ok: false; errors: string[] };

/** Parse and strict-validate policies against the Bastion schema (10.2, 10.3). */
export const validateStrict = (policies: Record<string, string>): ValidationOutcome => {
  const result = cedar.validate({
    schema: loadSchema(),
    policies: { staticPolicies: policies },
    validationSettings: { mode: 'strict' },
  });
  if (result.type === 'failure') return { ok: false, errors: formatErrors(result.errors) };
  if (result.validationErrors.length > 0) {
    return { ok: false, errors: result.validationErrors.map((e) => e.error.message) };
  }
  return { ok: true };
};

export type { EntityJson };
