import { splitPolicies } from './cedar';
import { PolicyGenerationError } from './errors';
import { assertSafeId, cedarString, globToCedarLike, isGlob } from './escape';
import { INVOCATION_ACTIONS, NAMESPACE, VISIBILITY_ACTIONS } from './schema';
import { ROLE_TEMPLATES } from './templates';
import {
  type ArgCondition,
  type PolicyData,
  type PolicyEntry,
  type ToolRuleRow,
  toolRuleRowSchema,
} from './types';

export const entityRef = (type: string, id: string): string =>
  `${NAMESPACE}::${type}::${cedarString(id)}`;
export const actionRef = (action: string): string => entityRef('Action', action);

const actionList = (actions: readonly string[]): string => `[${actions.map(actionRef).join(', ')}]`;

const policyText = (id: string, effect: 'permit' | 'forbid', head: string, conditions: string[]) =>
  `@id(${cedarString(id)})\n${effect} (${head})${
    conditions.length > 0 ? `\nwhen { ${conditions.join(' && ')} }` : ''
  };`;

// --- role templates (10.3) ---------------------------------------------------------------------------

/** The fixed role policies of `templates/*.cedar`, from the string constants (no file access). */
export const roleTemplatePolicies = (): PolicyEntry[] =>
  Object.entries(ROLE_TEMPLATES).flatMap(([name, text]) => splitPolicies(text, `role.${name}`));

/** Role policies that depend on org data: manager call-log visibility and org-wide publishers. */
export const dataDrivenRolePolicies = (
  data: Pick<PolicyData, 'settings' | 'orgWidePublisherIds'>,
): PolicyEntry[] => {
  const out: PolicyEntry[] = [];
  if (data.settings.logsManagerVisibility) {
    for (const type of ['Team', 'User'] as const) {
      out.push({
        id: `role.manager.logs-${type.toLowerCase()}`,
        text: policyText(
          `role.manager.logs-${type.toLowerCase()}`,
          'permit',
          `principal is ${NAMESPACE}::User, action == ${actionRef('logs.view')}, resource is ${NAMESPACE}::${type}`,
          ['resource in principal.managedTeams'],
        ),
      });
    }
  }
  if (data.orgWidePublisherIds.length > 0) {
    const users = data.orgWidePublisherIds.map((id) => `principal == ${entityRef('User', id)}`);
    out.push({
      id: 'role.manager.publish-org',
      text: policyText(
        'role.manager.publish-org',
        'permit',
        `principal is ${NAMESPACE}::User, action == ${actionRef('catalog.publish')}, resource is ${NAMESPACE}::Org`,
        [users.length === 1 ? (users[0] ?? 'false') : `(${users.join(' || ')})`],
      ),
    });
  }
  return out;
};

// --- visibility and installation ownership (10.3) ---------------------------------------------------

/**
 * Visibility policies from catalog visibility (11.1): who sees a catalog entry and may install it.
 * `visibility.org` covers every principal of the org; team and user lists add policies.
 */
export const visibilityPolicies = (
  entry: PolicyData['catalogEntries'][number],
  orgId: string,
): PolicyEntry[] => {
  assertSafeId(entry.id, 'catalog entry id');
  const actions = actionList(['seeCatalog', 'installation.manage']);
  const resource = `resource == ${entityRef('CatalogEntry', entry.id)}`;
  const out: PolicyEntry[] = [];
  const add = (suffix: string, principal: string, conditions: string[] = []) => {
    const id = `visibility-${entry.id}-${suffix}`;
    out.push({
      id,
      text: policyText(id, 'permit', `${principal}, action in ${actions}, ${resource}`, conditions),
    });
  };
  if (entry.visibility.org) add('org', `principal in ${entityRef('Org', orgId)}`);
  const anyOf = (type: string, ids: string[]) => {
    const parts = ids.map((id) => `principal in ${entityRef(type, id)}`);
    return parts.length > 1 ? `(${parts.join(' || ')})` : (parts[0] ?? 'false');
  };
  if (entry.visibility.teamIds.length > 0) {
    add('teams', 'principal', [anyOf('Team', entry.visibility.teamIds)]);
  }
  if (entry.visibility.userIds.length > 0) {
    add('users', 'principal', [anyOf('User', entry.visibility.userIds)]);
  }
  return out;
};

const USE_ACTIONS = [...INVOCATION_ACTIONS, ...VISIBILITY_ACTIONS];

/**
 * Installation ownership (10.3): the principals who may use an installation may see and call everything
 * it exposes. A user's installation is theirs; a team installation is shared with the team's users; a
 * service account's installation is its own.
 */
export const ownershipPolicy = (
  installation: PolicyData['installations'][number],
): PolicyEntry | null => {
  assertSafeId(installation.id, 'installation id');
  let principal: string;
  if (installation.ownerUserId)
    principal = `principal == ${entityRef('User', installation.ownerUserId)}`;
  else if (installation.ownerTeamId) {
    principal = `principal is ${NAMESPACE}::User in ${entityRef('Team', installation.ownerTeamId)}`;
  } else if (installation.ownerServiceId) {
    principal = `principal == ${entityRef('ServiceAccount', installation.ownerServiceId)}`;
  } else return null;
  const id = `use-${installation.id}`;
  return {
    id,
    text: policyText(
      id,
      'permit',
      `${principal}, action in ${actionList(USE_ACTIONS)}, resource in ${entityRef('Installation', installation.id)}`,
      [],
    ),
  };
};

// --- tool rules (10.3) -------------------------------------------------------------------------------

const ROLE_EXPR: Record<string, string> = {
  admin: 'principal.role == "admin"',
  auditor: 'principal.role == "auditor"',
  member: 'principal.role == "member"',
  manager: '!principal.managedTeams.isEmpty()',
};

const whoClause = (who: ToolRuleRow['who']): { scope: string; condition?: string } => {
  const selectors: Array<{ scope: string; expr: string }> = [];
  if (who.role) {
    selectors.push({
      scope: `principal is ${NAMESPACE}::User`,
      expr: `principal is ${NAMESPACE}::User && ${ROLE_EXPR[who.role]}`,
    });
  }
  const sets: Array<[string, string[] | undefined]> = [
    ['Team', who.teams],
    ['User', who.users],
    ['ServiceAccount', who.serviceAccounts],
  ];
  for (const [type, ids] of sets) {
    for (const id of ids ?? []) {
      selectors.push({
        scope: `principal ${type === 'Team' ? 'in' : '=='} ${entityRef(type, id)}`,
        expr: `principal in ${entityRef(type, id)}`,
      });
    }
  }
  const only = selectors[0];
  if (selectors.length === 0) return { scope: 'principal' };
  if (selectors.length === 1 && only) {
    // A lone role keeps the type in scope and the role test in `when`.
    if (who.role) return { scope: only.scope, condition: ROLE_EXPR[who.role] ?? 'false' };
    return { scope: only.scope };
  }
  return {
    scope: 'principal',
    condition: `(${selectors.map((s) => (s.expr.includes('&&') ? `(${s.expr})` : s.expr)).join(' || ')})`,
  };
};

const annotationConditions = (annotations: NonNullable<ToolRuleRow['what']['annotations']>) =>
  (['readOnly', 'destructive', 'openWorld'] as const).flatMap((key) => {
    const value = annotations[key];
    if (value === undefined) return [];
    return [value ? `resource.${key}` : `!resource.${key}`];
  });

const argCondition = (arg: ArgCondition): string => {
  const name = cedarString(arg.name);
  const has = `context.call.hasTag(${name})`;
  const get = `context.call.getTag(${name})`;
  switch (arg.op) {
    case 'eq':
      return `${has} && ${get} == ${cedarString(arg.value)}`;
    case 'ne':
      return `${has} && ${get} != ${cedarString(arg.value)}`;
    case 'in':
      return `${has} && [${arg.values.map(cedarString).join(', ')}].contains(${get})`;
    case 'like':
      return `${has} && ${get} like ${globToCedarLike(arg.pattern)}`;
    case 'exists':
      return has;
    case 'notExists':
      return `!${has}`;
  }
};

const hasWhenConditions = (when: ToolRuleRow['when']): boolean =>
  (when.clientIds?.length ?? 0) > 0 ||
  when.hours !== undefined ||
  (when.weekdays?.length ?? 0) > 0 ||
  (when.ipCidrs?.length ?? 0) > 0 ||
  (when.args?.length ?? 0) > 0;

const whenConditions = (when: ToolRuleRow['when']): string[] => {
  const out: string[] = [];
  const clients = when.clientIds ?? [];
  if (clients.length === 1) out.push(`context.clientId == ${cedarString(clients[0] ?? '')}`);
  else if (clients.length > 1)
    out.push(`[${clients.map(cedarString).join(', ')}].contains(context.clientId)`);
  if (when.hours) {
    const { from, to } = when.hours;
    if (from === to) throw new PolicyGenerationError('hours.from and hours.to must differ');
    if (from < to) {
      out.push(
        to >= 24 ? `context.hour >= ${from}` : `(context.hour >= ${from} && context.hour < ${to})`,
      );
    } else out.push(`(context.hour >= ${from} || context.hour < ${to})`);
  }
  const weekdays = when.weekdays ?? [];
  if (weekdays.length > 0) out.push(`[${weekdays.join(', ')}].contains(context.weekday)`);
  const ips = when.ipCidrs ?? [];
  if (ips.length > 0) {
    const ranges = ips.map((cidr) => `context.ip.isInRange(ip(${cedarString(cidr)}))`);
    out.push(ranges.length === 1 ? (ranges[0] ?? 'false') : `(${ranges.join(' || ')})`);
  }
  const args = when.args ?? [];
  if (args.length > 0) out.push('context has call', ...args.map(argCondition));
  return out;
};

/**
 * Compiles one tool-rule row to Cedar. A row without `when` conditions compiles to two policies (seeTool and
 * callTool) so a forbid also hides the tool; any other row compiles to a callTool policy only. Every policy
 * is annotated `@id("rule-<id>")`; the seeTool twin is `rule-<id>.see`.
 */
export const compileRule = (input: ToolRuleRow): PolicyEntry[] => {
  const row = toolRuleRowSchema.parse(input);
  assertSafeId(row.id, 'rule id');
  const who = whoClause(row.who);
  const what = row.what;
  const conditions: string[] = who.condition ? [who.condition] : [];
  let resourceScope = 'resource';
  if (what.installationId) {
    resourceScope = `resource in ${entityRef('Installation', what.installationId)}`;
    if (what.catalogEntryId) {
      conditions.push(`resource in ${entityRef('CatalogEntry', what.catalogEntryId)}`);
    }
  } else if (what.catalogEntryId) {
    resourceScope = `resource in ${entityRef('CatalogEntry', what.catalogEntryId)}`;
  }
  if (what.toolName && what.toolName !== '*') {
    conditions.push(
      isGlob(what.toolName)
        ? `resource.name like ${globToCedarLike(what.toolName)}`
        : `resource.name == ${cedarString(what.toolName)}`,
    );
  }
  if (what.annotations) conditions.push(...annotationConditions(what.annotations));

  const head = (action: string) => `${who.scope}, action == ${actionRef(action)}, ${resourceScope}`;
  const callId = `rule-${row.id}`;
  if (!hasWhenConditions(row.when)) {
    const seeId = `${callId}.see`;
    return [
      { id: seeId, text: policyText(seeId, row.effect, head('seeTool'), conditions) },
      { id: callId, text: policyText(callId, row.effect, head('callTool'), conditions) },
    ];
  }
  return [
    {
      id: callId,
      text: policyText(callId, row.effect, head('callTool'), [
        ...conditions,
        ...whenConditions(row.when),
      ]),
    },
  ];
};

// --- the effective set -------------------------------------------------------------------------------

/**
 * Role templates + data-driven role policies + visibility + ownership + tool rules (10.3). Custom policies
 * are appended by the engine after their own validation. Pure: same data, same policies, same order.
 */
export const generatePolicySet = (data: PolicyData): PolicyEntry[] => [
  ...roleTemplatePolicies(),
  ...dataDrivenRolePolicies(data),
  ...data.catalogEntries.flatMap((entry) => visibilityPolicies(entry, data.orgId)),
  ...data.installations.flatMap((i) => {
    const policy = ownershipPolicy(i);
    return policy ? [policy] : [];
  }),
  ...data.rules.flatMap(compileRule),
];
