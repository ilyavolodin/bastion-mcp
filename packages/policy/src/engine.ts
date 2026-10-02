import type { Context, EntityJson } from '@cedar-policy/cedar-wasm/nodejs';
import {
  analyzePolicyJson,
  cedar,
  formatErrors,
  matchSegments,
  type PolicyAnalysis,
  policyToJson,
  splitPolicies,
  validateStrict,
} from './cedar';
import {
  buildContext,
  buildToolCallEntity,
  deriveToolFlags,
  mergeEntities,
  principalSlice,
  resourceSlice,
} from './entities';
import { PolicyEvaluationError, PolicyGenerationError } from './errors';
import { generatePolicySet } from './generate';
import type { PolicyDataSource } from './ports';
import { isMcpAction, NAMESPACE, type PolicyAction } from './schema';
import {
  type AuthorizeRequest,
  type Decision,
  type McpRequestContext,
  type PolicyData,
  type PolicyDataInput,
  type PolicyEntry,
  type PrincipalData,
  policyDataSchema,
  type ResourceData,
  type VisibilityResource,
} from './types';

export type DecisionEvent = {
  action: PolicyAction;
  decision: 'allow' | 'deny';
  durationMs: number;
};

export type EngineOptions = {
  /** Called after every evaluation (for `bastion.*` metrics, 15.3); must not throw. */
  onDecision?: (event: DecisionEvent) => void;
  /** Compiled policy-set slots kept across all engines in the process (default 1024). */
  maxCachedSets?: number;
};

// --- resource typing of actions ----------------------------------------------------------------------

const MCP_RESOURCE_TYPES: Record<string, readonly ResourceData['type'][]> = {
  useInstallation: ['Installation'],
  seeTool: ['Tool'],
  callTool: ['Tool'],
  seePrompt: ['Prompt'],
  getPrompt: ['Prompt'],
  seeResource: ['Resource'],
  readResource: ['Resource'],
  subscribeResource: ['Resource'],
  complete: ['Prompt', 'Resource'],
};
const MANAGEMENT_RESOURCE_TYPES: readonly ResourceData['type'][] = [
  'Org',
  'Team',
  'CatalogEntry',
  'Installation',
  'User',
];

const assertActionResource = (action: PolicyAction, resource: ResourceData): void => {
  const allowed = MCP_RESOURCE_TYPES[action] ?? MANAGEMENT_RESOURCE_TYPES;
  if (!allowed.includes(resource.type)) {
    throw new PolicyEvaluationError(
      `Action ${action} does not apply to resource ${resource.type}`,
      {
        action,
        resourceType: resource.type,
      },
    );
  }
};

// --- compiled-set cache (shared, bounded: cedar-wasm offers no way to free a preparsed set) --------------

class SlotCache {
  private readonly slots = new Map<string, string>();
  private nextSlot = 0;
  constructor(private capacity: number) {}

  setCapacity(capacity: number): void {
    this.capacity = Math.max(capacity, 16);
  }

  get(key: string): string | undefined {
    const slot = this.slots.get(key);
    if (slot !== undefined) {
      this.slots.delete(key);
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Reserves a slot id for `key`, recycling the least recently used slot when full. */
  reserve(key: string): string {
    let slot: string;
    if (this.slots.size >= this.capacity) {
      const oldest = this.slots.keys().next();
      const oldKey = oldest.value as string;
      slot = this.slots.get(oldKey) ?? `bastion-slot-${this.nextSlot++}`;
      this.slots.delete(oldKey);
    } else {
      slot = `bastion-slot-${this.nextSlot++}`;
    }
    this.slots.set(key, slot);
    return slot;
  }

  drop(key: string): void {
    this.slots.delete(key);
  }
}

const slotCache = new SlotCache(1024);
let engineCounter = 0;

// --- shards -------------------------------------------------------------------------------------------

type Indexed = { entry: PolicyEntry; analysis: PolicyAnalysis };
/** `plain` policies always apply to the shard's requests; `matched` carry a name/uri conjunct (see below). */
type Shard = { plain: Indexed[]; matched: Indexed[] };
type Target = { attr: 'name' | 'uri'; value: string };
type Combo = { slot: string | null; attrs: ReadonlySet<string>; identity: boolean };

const WILDCARD = '*';
const shardKey = (action: string, principal: string, resource: string): string =>
  `${action}\u0001${principal}\u0001${resource}`;

/** What `authorize` returns: a decision with the policies that determined it (10.4). */
export type { Decision };

export type FilterResult<T> = {
  visible: T[];
  hidden: Array<{ item: T; reasons: string[] }>;
};

/**
 * In-process Cedar evaluation of the effective policy set (10.4).
 *
 * The set is partitioned by what each policy can match (action, principal anchor, resource anchor), so a
 * request evaluates only the few policies that can apply, which keeps p99 under 1 ms for 2,000 policies.
 * Partitioning never changes a decision: policies that could apply are always included.
 */
export class PolicyEngine {
  readonly orgId: string;
  private readonly id = ++engineCounter;
  private readonly policies: PolicyEntry[];
  private readonly texts = new Map<string, string>();
  private readonly shards = new Map<string, Shard>();
  private readonly combos = new Map<string, Combo>();
  private readonly onDecision: ((event: DecisionEvent) => void) | undefined;

  private constructor(data: PolicyData, options: EngineOptions) {
    this.orgId = data.orgId;
    this.onDecision = options.onDecision;
    if (options.maxCachedSets !== undefined) slotCache.setCapacity(options.maxCachedSets);
    this.policies = [...generatePolicySet(data), ...PolicyEngine.customEntries(data)];
    for (const entry of this.policies) {
      this.texts.set(entry.id, entry.text);
      const analysis = analyzePolicyJson(policyToJson(entry.text));
      for (const action of analysis.actions ?? [WILDCARD]) {
        const key = shardKey(action, analysis.principal ?? WILDCARD, analysis.resource ?? WILDCARD);
        let shard = this.shards.get(key);
        if (!shard) {
          shard = { plain: [], matched: [] };
          this.shards.set(key, shard);
        }
        (analysis.matcher ? shard.matched : shard.plain).push({ entry, analysis });
      }
    }
  }

  /** Builds an engine from plain data; custom policies are strict-validated and any error fails closed. */
  static create(input: PolicyDataInput | PolicyData, options: EngineOptions = {}): PolicyEngine {
    return new PolicyEngine(policyDataSchema.parse(input), options);
  }

  static async fromDataSource(
    source: PolicyDataSource,
    options: EngineOptions = {},
    signal?: AbortSignal,
  ): Promise<PolicyEngine> {
    return PolicyEngine.create(await source.load(signal), options);
  }

  private static customEntries(data: PolicyData): PolicyEntry[] {
    const out: PolicyEntry[] = [];
    for (const custom of data.customPolicies) {
      const parts = splitPolicies(custom.cedar, `custom-${custom.id}`);
      const renamed = parts.map((p, index) => ({
        id: `custom-${custom.id}.${p.id.startsWith(`custom-${custom.id}.`) ? index : p.id}`,
        text: p.text,
      }));
      const check = validateStrict(Object.fromEntries(renamed.map((p) => [p.id, p.text])));
      if (!check.ok) {
        throw new PolicyGenerationError(`Custom policy ${custom.id} fails strict validation`, {
          errors: check.errors,
        });
      }
      out.push(...renamed);
    }
    return out;
  }

  /** Ids of every policy in the effective set, in generation order. */
  policyIds(): string[] {
    return this.policies.map((p) => p.id);
  }

  get policyCount(): number {
    return this.policies.length;
  }

  /** The Cedar text of the effective set (for the policy viewer and bundle publication). */
  policyText(id: string): string | undefined {
    return this.texts.get(id);
  }

  // --- evaluation ---------------------------------------------------------------------------------------

  /**
   * The compiled set for a request: the policies of every shard that can apply, minus policies whose
   * `resource.name`/`resource.uri` conjunct is false for `target` (such a policy can neither permit nor
   * forbid it). Sets are cached, so steady traffic parses nothing.
   */
  private comboFor(
    action: string,
    principalKeys: string[],
    resourceKeys: string[],
    target?: Target,
  ): Combo {
    const keys: string[] = [];
    for (const a of [action, WILDCARD]) {
      for (const p of [WILDCARD, ...principalKeys]) {
        for (const r of [WILDCARD, ...resourceKeys]) {
          const key = shardKey(a, p, r);
          if (this.shards.has(key)) keys.push(key);
        }
      }
    }
    const included: Indexed[] = [];
    for (const key of keys) {
      for (const item of this.shards.get(key)?.matched ?? []) {
        const matcher = item.analysis.matcher;
        if (
          !target ||
          !matcher ||
          matcher.attr !== target.attr ||
          matchSegments(matcher.segments, target.value)
        ) {
          included.push(item);
        }
      }
    }
    const comboKey = `${keys.join('')}${included.map((i) => i.entry.id).join('')}`;
    const cached = this.combos.get(comboKey);
    if (
      cached &&
      (cached.slot === null || slotCache.get(`${this.id}|${comboKey}`) === cached.slot)
    ) {
      return cached;
    }
    const attrs = new Set<string>();
    let identity = false;
    const staticPolicies: Record<string, string> = {};
    const add = (item: Indexed) => {
      staticPolicies[item.entry.id] = item.entry.text;
      for (const a of item.analysis.resourceAttrs) attrs.add(a);
      identity ||= item.analysis.resourceIdentity;
    };
    for (const key of keys) for (const item of this.shards.get(key)?.plain ?? []) add(item);
    for (const item of included) add(item);
    const hasPolicies = Object.keys(staticPolicies).length > 0;
    let slot: string | null = null;
    if (hasPolicies) {
      slot = slotCache.reserve(`${this.id}|${comboKey}`);
      const parsed = cedar.preparsePolicySet(slot, { staticPolicies });
      if (parsed.type !== 'success') {
        slotCache.drop(`${this.id}|${comboKey}`);
        throw new PolicyEvaluationError('Policy set does not parse', {
          errors: formatErrors(parsed.errors),
        });
      }
    }
    const combo: Combo = { slot, attrs, identity };
    this.combos.set(comboKey, combo);
    if (this.combos.size > 4096) this.combos.clear();
    return combo;
  }

  private evaluate(
    action: PolicyAction,
    principalUid: { type: string; id: string },
    resourceUid: { type: string; id: string },
    context: Context,
    entities: EntityJson[],
    combo: Combo,
  ): Decision {
    if (combo.slot === null) return { decision: 'deny', reasons: [], errors: [] };
    const answer = cedar.statefulIsAuthorized({
      principal: principalUid,
      action: { type: `${NAMESPACE}::Action`, id: action },
      resource: resourceUid,
      context,
      preparsedPolicySetId: combo.slot,
      entities,
    });
    if (answer.type !== 'success') {
      throw new PolicyEvaluationError('Cedar evaluation failed', {
        errors: formatErrors(answer.errors),
      });
    }
    const { decision, diagnostics } = answer.response;
    return {
      decision,
      reasons: [...diagnostics.reason],
      errors: diagnostics.errors.map((e) => e.policyId),
    };
  }

  /**
   * Decides one request. Management actions take an empty context; MCP actions require `context`.
   * `forbid` always wins; a default deny has no reasons.
   */
  authorize(request: AuthorizeRequest): Decision {
    const started = performance.now();
    const { principal, action, resource } = request;
    assertActionResource(action, resource);
    const mcp = isMcpAction(action);
    if (mcp && !request.context) {
      throw new PolicyEvaluationError(`Action ${action} needs a request context`, { action });
    }
    const p = principalSlice(principal, this.orgId);
    const r = resourceSlice(resource, this.orgId);
    const withCall = mcp && action === 'callTool' && request.call !== undefined;
    const callEntity = withCall ? [buildToolCallEntity(request.call)] : [];
    const context: Context = mcp && request.context ? buildContext(request.context, withCall) : {};
    const combo = this.comboFor(action, p.ancestors, r.ancestors, targetOf(resource));
    const result = this.evaluate(
      action,
      p.uid,
      r.uid,
      context,
      mergeEntities([p.entities, r.entities, callEntity]),
      combo,
    );
    this.onDecision?.({
      action,
      decision: result.decision,
      durationMs: performance.now() - started,
    });
    return result;
  }

  /**
   * Batch visibility for endpoint compilation (7.2, 10.4): items the principal may not see are removed, and
   * a hidden item looks exactly like a nonexistent one (6.9). Items that no policy can tell apart share one
   * evaluation, so listing 1,000 tools costs a handful of Cedar calls.
   */
  filterVisible<T extends VisibilityResource>(
    request: {
      principal: PrincipalData;
      action: 'seeTool' | 'seePrompt' | 'seeResource';
      context: McpRequestContext;
    },
    items: readonly T[],
  ): FilterResult<T> {
    const { principal, action } = request;
    const p = principalSlice(principal, this.orgId);
    const context = buildContext(request.context, false);
    const memo = new Map<string, Decision>();
    const visible: T[] = [];
    const hidden: Array<{ item: T; reasons: string[] }> = [];
    for (const item of items) {
      assertActionResource(action, item);
      const r = resourceSlice(item, this.orgId);
      const combo = this.comboFor(action, p.ancestors, r.ancestors, targetOf(item));
      const attrValues = [...combo.attrs]
        .sort()
        .map((a) => JSON.stringify(attributeOf(item, a)))
        .join(',');
      const signature = `${r.ancestors.slice(1).join('>')}|${combo.slot}|${attrValues}${
        combo.identity ? `|${r.uid.id}` : ''
      }`;
      let result = memo.get(signature);
      if (!result) {
        const started = performance.now();
        result = this.evaluate(
          action,
          p.uid,
          r.uid,
          context,
          mergeEntities([p.entities, r.entities]),
          combo,
        );
        this.onDecision?.({
          action,
          decision: result.decision,
          durationMs: performance.now() - started,
        });
        memo.set(signature, result);
      }
      if (result.decision === 'allow') visible.push(item);
      else hidden.push({ item, reasons: result.reasons });
    }
    return { visible, hidden };
  }
}

const targetOf = (resource: ResourceData): Target | undefined => {
  switch (resource.type) {
    case 'Tool':
    case 'Prompt':
      return { attr: 'name', value: resource.name };
    case 'Resource':
      return { attr: 'uri', value: resource.uri };
    default:
      return undefined;
  }
};

const attributeOf = (item: VisibilityResource, attr: string): unknown => {
  switch (item.type) {
    case 'Tool':
      return (
        ({ name: item.name, ...deriveToolFlags(item.annotations) } as Record<string, unknown>)[
          attr
        ] ?? null
      );
    case 'Prompt':
      return attr === 'name' ? item.name : null;
    case 'Resource':
      return attr === 'uri' ? item.uri : null;
  }
};
