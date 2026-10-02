import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AuthorizeRequest,
  generatePolicySet,
  PolicyEngine,
  policyDataSchema,
  type ToolRuleRowInput,
  type VisibilityResource,
} from '../src';
import { cedar } from '../src/cedar';
import {
  buildContext,
  buildToolCallEntity,
  mergeEntities,
  principalSlice,
  resourceSlice,
} from '../src/entities';
import {
  admin,
  auditor,
  context,
  data,
  installationResource,
  instMember,
  instOther,
  instTeam,
  manager,
  member,
  orgResource,
  outsider,
  teamResource,
  tool,
  userResource,
} from './fixtures';

const principals = [admin, manager, member, auditor, outsider];

const toolName = fc.constantFrom('a', 'b', 'ab', 'abc', 'delete_x', 'list');
const effect = fc.constantFrom('permit', 'forbid') as fc.Arbitrary<'permit' | 'forbid'>;
const who = fc.constantFrom<NonNullable<ToolRuleRowInput['who']>[]>(
  {},
  { teams: ['t'] },
  { users: ['mem1'] },
  { teams: ['u'] },
  { role: 'member' },
);
const what: fc.Arbitrary<NonNullable<ToolRuleRowInput['what']>> = fc.oneof(
  fc.constant({}),
  toolName.map((n) => ({ toolName: n })),
  fc.constantFrom('a*', 'ab*', '*x', '*b*').map((g) => ({ toolName: g })),
  fc.constantFrom(true, false).map((destructive) => ({ annotations: { destructive } })),
  fc.constant({ installationId: 'inst-mem' }),
  fc.constant({ catalogEntryId: 'e-t' }),
);
const rowArb = (id: number): fc.Arbitrary<ToolRuleRowInput> =>
  fc.record({ effect, who, what }).map((r) => ({ id: `r${id}`, ...r }));
const rowsArb = fc
  .integer({ min: 1, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => rowArb(i))));
const toolArb = fc.record({
  inst: fc.constantFrom(instMember, instTeam, instOther),
  name: toolName,
  destructive: fc.option(fc.boolean(), { nil: undefined }),
});

const matchesGlob = (glob: string | undefined, name: string): boolean => {
  if (glob === undefined) return true;
  const re = new RegExp(
    `^${glob
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name);
};

/** An oracle for no-condition rows, independent of Cedar. */
const rowApplies = (
  row: ToolRuleRowInput,
  principal: (typeof principals)[number],
  inst: { id: string; catalogEntryId: string },
  name: string,
  destructive: boolean,
): boolean => {
  const w = row.who ?? {};
  const isMember = principal.kind === 'user' && principal.role === 'member';
  const inTeam = (t: string) =>
    principal.kind === 'user' && principal.teams.some((x) => x.id === t);
  const whoOk =
    (w.teams === undefined && w.users === undefined && w.role === undefined) ||
    (w.teams?.some(inTeam) ?? false) ||
    (w.users?.includes(principal.id) ?? false) ||
    (w.role === 'member' && isMember);
  const x = row.what ?? {};
  const whatOk =
    matchesGlob(x.toolName, name) &&
    (x.annotations?.destructive === undefined || x.annotations.destructive === destructive) &&
    (x.installationId === undefined || x.installationId === inst.id) &&
    (x.catalogEntryId === undefined || x.catalogEntryId === inst.catalogEntryId);
  return whoOk && whatOk;
};

describe('10.3 properties', () => {
  it('10.3 forbid always wins: a matching no-condition forbid denies both seeTool and callTool, naming its rule', () => {
    fc.assert(
      fc.property(rowsArb, fc.constantFrom(...principals), toolArb, (rows, principal, t) => {
        const engine = PolicyEngine.create(data({ rules: rows }));
        const destructive = t.destructive ?? true;
        const resource = tool(
          t.inst,
          t.name,
          t.destructive === undefined ? {} : { destructiveHint: t.destructive },
        );
        const matchingForbids = rows
          .filter(
            (r) => r.effect === 'forbid' && rowApplies(r, principal, t.inst, t.name, destructive),
          )
          .map((r) => r.id);
        for (const [action, suffix] of [
          ['callTool', ''],
          ['seeTool', '.see'],
        ] as const) {
          const decision = engine.authorize({ principal, action, resource, context });
          if (matchingForbids.length > 0) {
            expect(decision.decision).toBe('deny');
            expect([...decision.reasons].sort()).toEqual(
              matchingForbids.map((id) => `rule-${id}${suffix}`).sort(),
            );
          }
        }
      }),
      { numRuns: 120 },
    );
  });

  it('10.3 without a matching forbid, a usable installation or a matching permit allows; otherwise deny', () => {
    fc.assert(
      fc.property(rowsArb, fc.constantFrom(...principals), toolArb, (rows, principal, t) => {
        const engine = PolicyEngine.create(data({ rules: rows }));
        const destructive = t.destructive ?? true;
        const anyForbid = rows.some(
          (r) => r.effect === 'forbid' && rowApplies(r, principal, t.inst, t.name, destructive),
        );
        const anyPermit = rows.some(
          (r) => r.effect === 'permit' && rowApplies(r, principal, t.inst, t.name, destructive),
        );
        const mayUse =
          anyPermit ||
          (t.inst === instMember && principal.id === 'mem1') ||
          (t.inst === instOther && principal.id === 'oth1') ||
          (t.inst === instTeam && (principal.id === 'mem1' || principal.id === 'mgr1'));
        const decision = engine.authorize({
          principal,
          action: 'callTool',
          resource: tool(
            t.inst,
            t.name,
            t.destructive === undefined ? {} : { destructiveHint: t.destructive },
          ),
          context,
        });
        expect(decision.decision).toBe(!anyForbid && mayUse ? 'allow' : 'deny');
      }),
      { numRuns: 120 },
    );
  });

  it('6.9 hidden equals nonexistent: for no-condition rows a hidden tool (seeTool deny) is also not callable', () => {
    fc.assert(
      fc.property(rowsArb, fc.constantFrom(...principals), toolArb, (rows, principal, t) => {
        const engine = PolicyEngine.create(data({ rules: rows }));
        const resource = tool(
          t.inst,
          t.name,
          t.destructive === undefined ? {} : { destructiveHint: t.destructive },
        );
        const see = engine.authorize({ principal, action: 'seeTool', resource, context });
        const call = engine.authorize({ principal, action: 'callTool', resource, context });
        expect(call.decision).toBe(see.decision);
      }),
      { numRuns: 120 },
    );
  });

  it('10.4 filterVisible equals evaluating seeTool for every item (the shared-evaluation memo is sound)', () => {
    fc.assert(
      fc.property(
        rowsArb,
        fc.constantFrom(...principals),
        fc.array(toolArb, { minLength: 1, maxLength: 25 }),
        (rows, principal, ts) => {
          const engine = PolicyEngine.create(data({ rules: rows }));
          const items = ts
            .map((t) =>
              tool(
                t.inst,
                t.name,
                t.destructive === undefined ? {} : { destructiveHint: t.destructive },
              ),
            )
            .filter((i): i is VisibilityResource => i.type === 'Tool');
          const batch = engine.filterVisible({ principal, action: 'seeTool', context }, items);
          const expected = items.filter(
            (item) =>
              engine.authorize({ principal, action: 'seeTool', resource: item, context })
                .decision === 'allow',
          );
          expect(batch.visible).toEqual(expected);
          expect(batch.visible.length + batch.hidden.length).toBe(items.length);
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe('10.4 sharding never changes a decision', () => {
  const rules: ToolRuleRowInput[] = [
    { id: 'a', effect: 'forbid', who: { teams: ['t'] }, what: { toolName: 'del*' } },
    {
      id: 'b',
      effect: 'forbid',
      what: { installationId: 'inst-oth' },
      when: { hours: { from: 22, to: 6 } },
    },
    {
      id: 'c',
      effect: 'permit',
      who: { users: ['oth1'] },
      what: { catalogEntryId: 'e-u', toolName: 'x' },
    },
    {
      id: 'd',
      effect: 'forbid',
      who: { role: 'member' },
      what: { annotations: { destructive: true } },
      when: { args: [{ op: 'eq', name: 'k', value: 'v' }] },
    },
  ];
  const input = data({
    rules,
    orgWidePublisherIds: ['mgr1'],
    customPolicies: [
      {
        id: 'x',
        cedar:
          '@id("n")\nforbid (principal in Bastion::Team::"u", action == Bastion::Action::"seeCatalog", resource is Bastion::Org);',
      },
    ],
  });
  const engine = PolicyEngine.create(input);
  const parsed = policyDataSchema.parse(input);
  const everything = Object.fromEntries(
    [
      ...generatePolicySet(parsed),
      ...engine
        .policyIds()
        .filter((i) => i.startsWith('custom-'))
        .map((id) => ({ id, text: engine.policyText(id) ?? '' })),
    ].map((p) => [p.id, p.text]),
  );

  const requests: AuthorizeRequest[] = [];
  for (const principal of principals) {
    for (const inst of [instMember, instOther, instTeam]) {
      for (const name of ['del_x', 'x', 'list']) {
        for (const action of ['callTool', 'seeTool'] as const) {
          requests.push({
            principal,
            action,
            resource: tool(inst, name, { destructiveHint: name === 'del_x' }),
            context: { ...context, hour: 23 },
            call: { k: 'v' },
          });
        }
      }
      requests.push({
        principal,
        action: 'useInstallation',
        resource: installationResource(inst),
        context,
      });
      requests.push({
        principal,
        action: 'installation.manage',
        resource: installationResource(inst),
      });
    }
    for (const action of [
      'seeCatalog',
      'logs.view',
      'audit.view',
      'user.manage',
      'catalog.publish',
    ] as const) {
      requests.push({ principal, action, resource: orgResource() });
      requests.push({ principal, action, resource: teamResource('t') });
      requests.push({ principal, action, resource: userResource('mem1', ['t']) });
    }
  }

  it('10.4 the sharded engine agrees with evaluating the whole policy set in one Cedar call', () => {
    expect(requests.length).toBeGreaterThan(150);
    for (const request of requests) {
      const p = principalSlice(request.principal, 'org');
      const r = resourceSlice(request.resource, 'org');
      const mcp = request.context !== undefined;
      const withCall = request.action === 'callTool' && request.call !== undefined;
      const answer = cedar.isAuthorized({
        principal: p.uid,
        action: { type: 'Bastion::Action', id: request.action },
        resource: r.uid,
        context: mcp && request.context ? buildContext(request.context, withCall) : {},
        policies: { staticPolicies: everything },
        entities: mergeEntities([
          p.entities,
          r.entities,
          withCall ? [buildToolCallEntity(request.call)] : [],
        ]),
      });
      if (answer.type !== 'success') throw new Error('whole-set evaluation failed');
      const sharded = engine.authorize(request);
      const label = `${request.principal.id} ${request.action} ${r.uid.id}`;
      expect(sharded.decision, label).toBe(answer.response.decision);
      expect([...sharded.reasons].sort(), label).toEqual(
        [...answer.response.diagnostics.reason].sort(),
      );
    }
  });
});
