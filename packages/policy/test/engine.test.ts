import { describe, expect, it, vi } from 'vitest';
import {
  type DecisionEvent,
  type PolicyDataSource,
  PolicyEngine,
  PolicyEvaluationError,
  PolicyGenerationError,
  type ToolRuleRowInput,
  type VisibilityResource,
} from '../src';
import {
  admin,
  auditor,
  context,
  data,
  entryResource,
  installationResource,
  instMember,
  instOther,
  instService,
  instTeam,
  manager,
  member,
  orgResource,
  outsider,
  prompt,
  resource,
  serviceAccount,
  teamResource,
  tool,
  userResource,
} from './fixtures';

/** Reasons that come from tool rules (an allow also lists the default `use-*` permit). */
const ruleIds = (reasons: string[]): string[] => reasons.filter((r) => r.startsWith('rule-'));

const withRules = (...rules: ToolRuleRowInput[]) => PolicyEngine.create(data({ rules }));

describe('10.3 default behavior', () => {
  const engine = PolicyEngine.create(data());

  it('10.3 a principal who may use an installation may see and call all its tools, prompts and resources', () => {
    const t = tool(instMember, 'anything');
    for (const action of ['seeTool', 'callTool'] as const) {
      expect(engine.authorize({ principal: member, action, resource: t, context }).decision).toBe(
        'allow',
      );
    }
    expect(
      engine.authorize({
        principal: member,
        action: 'useInstallation',
        resource: installationResource(instMember),
        context,
      }).decision,
    ).toBe('allow');
    for (const action of ['seePrompt', 'getPrompt', 'complete'] as const) {
      expect(
        engine.authorize({ principal: member, action, resource: prompt(instMember, 'p'), context })
          .decision,
      ).toBe('allow');
    }
    for (const action of [
      'seeResource',
      'readResource',
      'subscribeResource',
      'complete',
    ] as const) {
      expect(
        engine.authorize({
          principal: member,
          action,
          resource: resource(instMember, 'file:///a'),
          context,
        }).decision,
      ).toBe('allow');
    }
  });

  it('10.3 an installation owned by someone else is not usable and its tools are denied', () => {
    const t = tool(instOther, 'x');
    const decision = engine.authorize({
      principal: member,
      action: 'callTool',
      resource: t,
      context,
    });
    expect(decision).toEqual({ decision: 'deny', reasons: [], errors: [] });
    expect(
      engine.authorize({
        principal: admin,
        action: 'useInstallation',
        resource: installationResource(instOther),
        context,
      }).decision,
    ).toBe('deny');
  });

  it('10.4 every allow reports the determining policy ids', () => {
    const decision = engine.authorize({
      principal: member,
      action: 'callTool',
      resource: tool(instMember, 'x'),
      context,
    });
    expect(decision.reasons).toEqual(['use-inst-mem']);
  });

  it('10.1 team installations are shared with the team members but not with other teams', () => {
    const t = tool(instTeam, 'x');
    expect(
      engine.authorize({ principal: member, action: 'callTool', resource: t, context }).decision,
    ).toBe('allow');
    expect(
      engine.authorize({ principal: manager, action: 'callTool', resource: t, context }).decision,
    ).toBe('allow');
    expect(
      engine.authorize({ principal: outsider, action: 'callTool', resource: t, context }).decision,
    ).toBe('deny');
  });

  it('10.1 a service account uses only its own installations, and never the team installations', () => {
    expect(
      engine.authorize({
        principal: serviceAccount,
        action: 'callTool',
        resource: tool(instService, 'x'),
        context,
      }).decision,
    ).toBe('allow');
    expect(
      engine.authorize({
        principal: serviceAccount,
        action: 'callTool',
        resource: tool(instTeam, 'x'),
        context,
      }).decision,
    ).toBe('deny');
  });

  it('10.1 service accounts hold member capabilities for their own installations only', () => {
    const allow = (
      action: 'installation.manage' | 'override.edit',
      r = installationResource(instService),
    ) => engine.authorize({ principal: serviceAccount, action, resource: r }).decision;
    expect(allow('installation.manage')).toBe('allow');
    expect(allow('override.edit')).toBe('allow');
    expect(allow('installation.manage', installationResource(instMember))).toBe('deny');
    expect(allow('installation.manage', installationResource(instTeam))).toBe('deny');
    for (const action of [
      'catalog.create',
      'user.manage',
      'settings.edit',
      'logs.view',
      'secrets.manage',
    ] as const) {
      expect(
        engine.authorize({ principal: serviceAccount, action, resource: teamResource('t') })
          .decision,
        action,
      ).toBe('deny');
    }
    expect(
      engine.authorize({
        principal: serviceAccount,
        action: 'installation.manage',
        resource: orgResource(),
      }).decision,
    ).toBe('deny');
  });

  it('10.1 a team manager administers the team service accounts and their installations', () => {
    expect(
      engine.authorize({
        principal: manager,
        action: 'installation.manage',
        resource: installationResource(instService),
      }).decision,
    ).toBe('allow');
    expect(
      engine.authorize({
        principal: member,
        action: 'installation.manage',
        resource: installationResource(instService),
      }).decision,
    ).toBe('deny');
  });

  it('10.3 deactivated principals are denied everything', () => {
    const inactive = { ...admin, active: false };
    expect(
      engine.authorize({ principal: inactive, action: 'settings.edit', resource: orgResource() }),
    ).toMatchObject({ decision: 'deny', reasons: ['guard.inactive'] });
    const inactiveMember = { ...member, active: false };
    expect(
      engine.authorize({
        principal: inactiveMember,
        action: 'callTool',
        resource: tool(instMember, 'x'),
        context,
      }).decision,
    ).toBe('deny');
  });
});

describe('10.1 data-driven capabilities', () => {
  it('10.1 managers see the call log of their team members only when logs.managerVisibility is on', () => {
    const on = PolicyEngine.create(data({ settings: { logsManagerVisibility: true } }));
    const off = PolicyEngine.create(data({ settings: { logsManagerVisibility: false } }));
    const r = userResource('mem1', ['t']);
    expect(on.authorize({ principal: manager, action: 'logs.view', resource: r }).decision).toBe(
      'allow',
    );
    expect(off.authorize({ principal: manager, action: 'logs.view', resource: r }).decision).toBe(
      'deny',
    );
    expect(
      off.authorize({ principal: member, action: 'logs.view', resource: userResource('mem1') })
        .decision,
    ).toBe('allow');
  });

  it('10.1 a manager publishes org-wide only with catalog.publishOrgWide', () => {
    const without = PolicyEngine.create(data());
    const withFlag = PolicyEngine.create(data({ orgWidePublisherIds: ['mgr1'] }));
    expect(
      without.authorize({ principal: manager, action: 'catalog.publish', resource: orgResource() })
        .decision,
    ).toBe('deny');
    expect(
      withFlag.authorize({ principal: manager, action: 'catalog.publish', resource: orgResource() })
        .decision,
    ).toBe('allow');
    expect(
      withFlag.authorize({ principal: member, action: 'catalog.publish', resource: orgResource() })
        .decision,
    ).toBe('deny');
  });

  it('11.1 catalog visibility: org, teams and users decide who sees and installs an entry', () => {
    const engine = PolicyEngine.create(
      data({
        catalogEntries: [
          {
            id: 'only-users',
            visibility: { org: false, teamIds: [], userIds: ['mem1'] },
            risk: 'low',
          },
          {
            id: 'only-team-u',
            visibility: { org: false, teamIds: ['u'], userIds: [] },
            risk: 'low',
          },
          { id: 'private', visibility: { org: false, teamIds: [], userIds: [] }, risk: 'low' },
        ],
      }),
    );
    const see = (principal: typeof member, id: string) =>
      engine.authorize({ principal, action: 'seeCatalog', resource: entryResource(id) }).decision;
    expect(see(member, 'only-users')).toBe('allow');
    expect(see(outsider, 'only-users')).toBe('deny');
    expect(see(outsider, 'only-team-u')).toBe('allow');
    expect(see(member, 'only-team-u')).toBe('deny');
    expect(see(member, 'private')).toBe('deny');
    expect(see(admin, 'private')).toBe('allow');
    expect(see(auditor, 'private')).toBe('allow');
    expect(
      engine.authorize({
        principal: member,
        action: 'installation.manage',
        resource: entryResource('only-users'),
      }).decision,
    ).toBe('allow');
  });
});

describe('10.3 tool rules', () => {
  it('10.3 a no-condition forbid hides the tool (seeTool) and blocks the call (callTool)', () => {
    const engine = withRules({
      id: 'f1',
      effect: 'forbid',
      who: { teams: ['t'] },
      what: { annotations: { destructive: true } },
    });
    const destructive = tool(instMember, 'drop', { destructiveHint: true });
    const safe = tool(instMember, 'list', { destructiveHint: false, readOnlyHint: true });
    const see = engine.authorize({
      principal: member,
      action: 'seeTool',
      resource: destructive,
      context,
    });
    expect(see).toMatchObject({ decision: 'deny', reasons: ['rule-f1.see'] });
    expect(
      engine.authorize({ principal: member, action: 'callTool', resource: destructive, context }),
    ).toMatchObject({
      decision: 'deny',
      reasons: ['rule-f1'],
    });
    expect(
      engine.authorize({ principal: member, action: 'callTool', resource: safe, context }).decision,
    ).toBe('allow');
    // Not in the team: unaffected.
    expect(
      engine.authorize({
        principal: admin,
        action: 'seeTool',
        resource: tool(instMember, 'drop'),
        context,
      }).decision,
    ).toBe('deny'); // admin does not own instMember: default deny, not the rule
    expect(
      engine.authorize({
        principal: admin,
        action: 'seeTool',
        resource: tool(instMember, 'drop'),
        context,
      }).reasons,
    ).toEqual([]);
  });

  it('10.3 the 10.3 example: forbid delete_repository unless the owner argument is acme-sandbox', () => {
    const engine = withRules({
      id: 'f2',
      effect: 'forbid',
      what: { toolName: 'delete_repository' },
      when: { args: [{ op: 'ne', name: 'owner', value: 'acme-sandbox' }] },
    });
    const t = tool(instMember, 'delete_repository');
    const call = (args: Record<string, unknown> | undefined) =>
      engine.authorize({
        principal: member,
        action: 'callTool',
        resource: t,
        context,
        ...(args ? { call: args } : {}),
      });
    expect(call({ owner: 'acme-sandbox' }).decision).toBe('allow');
    expect(call({ owner: 'acme-prod' })).toMatchObject({ decision: 'deny', reasons: ['rule-f2'] });
    // The rule needs the tag present; a call without the argument is not matched by the `!=` condition.
    expect(call({ repo: 'x' }).decision).toBe('allow');
    expect(call(undefined).decision).toBe('allow');
    // It still lists the tool: argument rules compile to callTool only.
    expect(
      engine.authorize({ principal: member, action: 'seeTool', resource: t, context }).decision,
    ).toBe('allow');
    // A different tool is unaffected.
    expect(
      engine.authorize({
        principal: member,
        action: 'callTool',
        resource: tool(instMember, 'other'),
        context,
        call: { owner: 'x' },
      }).decision,
    ).toBe('allow');
  });

  it('10.2 argument tags: numbers and booleans are strings, long strings are capped, nested values ignored', () => {
    const engine = withRules(
      { id: 'n', effect: 'forbid', when: { args: [{ op: 'eq', name: 'count', value: '3' }] } },
      { id: 'b', effect: 'forbid', when: { args: [{ op: 'eq', name: 'force', value: 'true' }] } },
      {
        id: 'l',
        effect: 'forbid',
        when: { args: [{ op: 'eq', name: 'long', value: 'x'.repeat(256) }] },
      },
      { id: 'o', effect: 'forbid', when: { args: [{ op: 'exists', name: 'nested' }] } },
    );
    const t = tool(instMember, 'x');
    const call = (args: Record<string, unknown>) =>
      ruleIds(
        engine.authorize({
          principal: member,
          action: 'callTool',
          resource: t,
          context,
          call: args,
        }).reasons,
      );
    expect(call({ count: 3 })).toEqual(['rule-n']);
    expect(call({ force: true })).toEqual(['rule-b']);
    expect(call({ long: 'x'.repeat(5000) })).toEqual(['rule-l']);
    expect(call({ nested: { a: 1 } })).toEqual([]);
    expect(call({ nested: ['a'] })).toEqual([]);
  });

  it('10.3 when conditions: client, hours, weekdays and IP ranges', () => {
    const engine = withRules(
      { id: 'c', effect: 'forbid', when: { clientIds: ['cursor'] } },
      { id: 'h', effect: 'forbid', when: { hours: { from: 22, to: 6 } } },
      { id: 'w', effect: 'forbid', when: { weekdays: [0, 6] } },
      { id: 'i', effect: 'forbid', when: { ipCidrs: ['192.168.0.0/16'] } },
    );
    const t = tool(instMember, 'x');
    const reasons = (override: Partial<typeof context>) =>
      ruleIds(
        engine.authorize({
          principal: member,
          action: 'callTool',
          resource: t,
          context: { ...context, ...override },
        }).reasons,
      );
    expect(reasons({})).toEqual([]);
    expect(reasons({ clientId: 'cursor' })).toEqual(['rule-c']);
    expect(reasons({ hour: 23 })).toEqual(['rule-h']);
    expect(reasons({ hour: 3 })).toEqual(['rule-h']);
    expect(reasons({ hour: 6 })).toEqual([]);
    expect(reasons({ weekday: 6 })).toEqual(['rule-w']);
    expect(reasons({ ip: '192.168.4.5' })).toEqual(['rule-i']);
    expect(reasons({ ip: '8.8.8.8' })).toEqual([]);
  });

  it('10.3 forbid always wins over permit rules and default permits', () => {
    const engine = withRules(
      { id: 'p', effect: 'permit', what: { toolName: 'drop' } },
      { id: 'f', effect: 'forbid', who: { users: ['mem1'] }, what: { toolName: 'drop' } },
    );
    const decision = engine.authorize({
      principal: member,
      action: 'callTool',
      resource: tool(instMember, 'drop'),
      context,
    });
    expect(decision.decision).toBe('deny');
    expect(decision.reasons).toEqual(['rule-f']);
  });

  it('10.3 rules scoped to an installation, a catalog entry and a role', () => {
    const engine = withRules(
      {
        id: 'i',
        effect: 'forbid',
        who: { role: 'member' },
        what: { installationId: 'inst-mem', toolName: 'rm_*' },
      },
      { id: 'e', effect: 'forbid', what: { catalogEntryId: 'e-t', toolName: 'x*' } },
    );
    const call = (inst: typeof instMember, name: string, principal = member) =>
      ruleIds(
        engine.authorize({ principal, action: 'callTool', resource: tool(inst, name), context })
          .reasons,
      );
    expect(call(instMember, 'rm_all')).toEqual(['rule-i']);
    expect(call(instMember, 'ls')).toEqual([]);
    expect(call(instTeam, 'xyz')).toEqual(['rule-e']);
    expect(call(instTeam, 'abc')).toEqual([]);
  });

  it('10.3 a service-account rule and a manager-role rule', () => {
    const engine = withRules(
      {
        id: 's',
        effect: 'forbid',
        who: { serviceAccounts: ['sa1'] },
        what: { annotations: { openWorld: true } },
      },
      { id: 'm', effect: 'forbid', who: { role: 'manager' } },
    );
    expect(
      engine.authorize({
        principal: serviceAccount,
        action: 'callTool',
        resource: tool(instService, 'x'),
        context,
      }).reasons,
    ).toEqual(['rule-s']);
    expect(
      engine.authorize({
        principal: manager,
        action: 'seeTool',
        resource: tool({ id: 'inst-mgr', catalogEntryId: 'e-org', ownerUserId: 'mgr1' }, 'x'),
        context,
      }).reasons,
    ).toEqual(['rule-m.see']);
    expect(
      engine.authorize({
        principal: member,
        action: 'callTool',
        resource: tool(instMember, 'x'),
        context,
      }).decision,
    ).toBe('allow');
  });
});

describe('10.2 tool flags from final annotations', () => {
  const engine = withRules({
    id: 'ro',
    effect: 'forbid',
    what: { annotations: { readOnly: true } },
  });
  it('10.2 missing hints use the MCP defaults: readOnly false, destructive true, openWorld true', () => {
    const rules = withRules({
      id: 'd',
      effect: 'forbid',
      when: { weekdays: [1, 2] },
      what: { annotations: { destructive: true, openWorld: true, readOnly: false } },
    });
    expect(
      ruleIds(
        rules.authorize({
          principal: member,
          action: 'callTool',
          resource: tool(instMember, 'x'),
          context,
        }).reasons,
      ),
    ).toEqual(['rule-d']);
    expect(
      ruleIds(
        rules.authorize({
          principal: member,
          action: 'callTool',
          resource: tool(instMember, 'x', { destructiveHint: false }),
          context,
        }).reasons,
      ),
    ).toEqual([]);
  });

  it('10.2 readOnlyHint true is what makes a tool match a readOnly filter', () => {
    expect(
      ruleIds(
        engine.authorize({
          principal: member,
          action: 'callTool',
          resource: tool(instMember, 'x', { readOnlyHint: true }),
          context,
        }).reasons,
      ),
    ).toEqual(['rule-ro']);
    expect(
      ruleIds(
        engine.authorize({
          principal: member,
          action: 'callTool',
          resource: tool(instMember, 'x'),
          context,
        }).reasons,
      ),
    ).toEqual([]);
  });
});

describe('10.4 filterVisible (endpoint compilation)', () => {
  const rules: ToolRuleRowInput[] = [
    { id: 'h1', effect: 'forbid', what: { toolName: 'secret_*' } },
    {
      id: 'h2',
      effect: 'forbid',
      who: { teams: ['t'] },
      what: { annotations: { destructive: true } },
    },
  ];
  const engine = withRules(...rules);
  const items: VisibilityResource[] = [
    tool(instMember, 'list', { destructiveHint: false }),
    tool(instMember, 'secret_key', { destructiveHint: false }),
    tool(instMember, 'drop'),
    tool(instMember, 'read', { destructiveHint: false }),
  ].filter((i): i is VisibilityResource => i.type === 'Tool');

  it('10.4 hidden tools are removed and reported with the rule that hid them', () => {
    const result = engine.filterVisible({ principal: member, action: 'seeTool', context }, items);
    expect(result.visible.map((t) => (t.type === 'Tool' ? t.name : ''))).toEqual(['list', 'read']);
    expect(result.hidden.map((h) => h.reasons)).toEqual([['rule-h1.see'], ['rule-h2.see']]);
  });

  it('6.9 a hidden tool is exactly as unavailable as a nonexistent one: callTool is denied too', () => {
    for (const hidden of [items[1], items[2]]) {
      if (!hidden) throw new Error('missing');
      expect(
        engine.authorize({ principal: member, action: 'callTool', resource: hidden, context })
          .decision,
      ).toBe('deny');
    }
  });

  it('10.4 prompts and resources are filtered by seePrompt and seeResource', () => {
    const e = PolicyEngine.create(data());
    const prompts = e.filterVisible(
      { principal: member, action: 'seePrompt', context },
      [prompt(instMember, 'p'), prompt(instOther, 'q')].filter(
        (i): i is VisibilityResource => i.type === 'Prompt',
      ),
    );
    expect(prompts.visible).toHaveLength(1);
    const resources = e.filterVisible(
      { principal: member, action: 'seeResource', context },
      [resource(instMember, 'a://1'), resource(instOther, 'a://2')].filter(
        (i): i is VisibilityResource => i.type === 'Resource',
      ),
    );
    expect(resources.visible).toHaveLength(1);
  });

  it('10.4 identical tools share one evaluation: 500 tools need a handful of Cedar calls', () => {
    const events: DecisionEvent[] = [];
    const counting = PolicyEngine.create(
      data({
        rules: [{ id: 'x', effect: 'forbid', what: { annotations: { destructive: true } } }],
      }),
      {
        onDecision: (e) => events.push(e),
      },
    );
    const many = Array.from({ length: 500 }, (_, i) =>
      tool(
        instMember,
        `tool_${i}`,
        i % 2 === 0 ? { destructiveHint: true } : { destructiveHint: false },
      ),
    ).filter((i): i is VisibilityResource => i.type === 'Tool');
    const result = counting.filterVisible({ principal: member, action: 'seeTool', context }, many);
    expect(result.visible).toHaveLength(250);
    expect(events.length).toBeLessThanOrEqual(4);
  });

  it('10.4 rules that read the tool name are evaluated per matching name, the rest share one', () => {
    const events: DecisionEvent[] = [];
    const e = PolicyEngine.create(
      data({ rules: [{ id: 'n', effect: 'forbid', what: { toolName: 'bad_*' } }] }),
      {
        onDecision: (ev) => events.push(ev),
      },
    );
    const many = ['bad_1', 'good', 'bad_2', 'fine']
      .map((n) => tool(instMember, n))
      .filter((i): i is VisibilityResource => i.type === 'Tool');
    const result = e.filterVisible({ principal: member, action: 'seeTool', context }, many);
    expect(result.visible).toHaveLength(2);
    expect(events.length).toBe(3); // bad_1, bad_2, and one shared evaluation for good + fine
  });
});

describe('10.4 engine API', () => {
  it('10.4 rejects an action that does not apply to the resource type (fail closed)', () => {
    const engine = PolicyEngine.create(data());
    expect(() =>
      engine.authorize({ principal: member, action: 'callTool', resource: orgResource(), context }),
    ).toThrow(PolicyEvaluationError);
    expect(() =>
      engine.authorize({
        principal: member,
        action: 'settings.edit',
        resource: tool(instMember, 'x'),
      }),
    ).toThrow(PolicyEvaluationError);
  });

  it('10.4 MCP actions require a request context', () => {
    const engine = PolicyEngine.create(data());
    expect(() =>
      engine.authorize({ principal: member, action: 'callTool', resource: tool(instMember, 'x') }),
    ).toThrow(/context/);
  });

  it('15.3 reports every decision to the onDecision hook', () => {
    const onDecision = vi.fn();
    const engine = PolicyEngine.create(data(), { onDecision });
    engine.authorize({ principal: admin, action: 'settings.edit', resource: orgResource() });
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'settings.edit', decision: 'allow' }),
    );
  });

  it('10.3 builds an engine from a PolicyDataSource port', async () => {
    const source: PolicyDataSource = { load: async () => data() };
    const engine = await PolicyEngine.fromDataSource(source);
    expect(engine.policyCount).toBeGreaterThan(20);
    expect(engine.policyIds()).toContain('role.admin.manage');
    expect(engine.policyText('role.admin.manage')).toContain('permit');
    expect(engine.policyText('nope')).toBeUndefined();
  });

  it('10.3 custom policies join the set with a prefixed id and take part in decisions', () => {
    const engine = PolicyEngine.create(
      data({
        customPolicies: [
          {
            id: 'c1',
            cedar:
              '@id("no-friday")\nforbid (principal, action == Bastion::Action::"callTool", resource) when { context.weekday == 5 };',
          },
        ],
      }),
    );
    const friday = { ...context, weekday: 5 };
    const decision = engine.authorize({
      principal: member,
      action: 'callTool',
      resource: tool(instMember, 'x'),
      context: friday,
    });
    expect(decision).toMatchObject({ decision: 'deny', reasons: ['custom-c1.no-friday'] });
  });

  it('10.3 an invalid custom policy fails closed when the engine is built', () => {
    expect(() =>
      PolicyEngine.create(
        data({
          customPolicies: [
            { id: 'bad', cedar: 'permit (principal, action, resource) when { resource.nope };' },
          ],
        }),
      ),
    ).toThrow(PolicyGenerationError);
    expect(() =>
      PolicyEngine.create(data({ customPolicies: [{ id: 'bad', cedar: 'this is not cedar' }] })),
    ).toThrow(PolicyEvaluationError);
  });

  it('10.4 the compiled-set cache recycles slots without changing decisions', () => {
    const engine = PolicyEngine.create(data(), { maxCachedSets: 16 });
    const outcomes = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      for (const principal of [admin, manager, member, auditor, outsider]) {
        for (const action of [
          'settings.edit',
          'seeCatalog',
          'logs.view',
          'user.manage',
          'audit.view',
        ] as const) {
          outcomes.add(
            `${round > 0 ? '' : 'first:'}${principal.id}:${action}:${engine.authorize({ principal, action, resource: teamResource('t') }).decision}`,
          );
        }
      }
    }
    // Decisions in rounds 2 and 3 equal those of round 1 for every (principal, action).
    const first = [...outcomes].filter((o) => o.startsWith('first:')).map((o) => o.slice(6));
    const later = [...outcomes].filter((o) => !o.startsWith('first:'));
    expect(new Set(later)).toEqual(new Set(first));
  });
});
