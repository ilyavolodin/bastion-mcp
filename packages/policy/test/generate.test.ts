import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compileRule,
  dataDrivenRolePolicies,
  escapeCedarString,
  generatePolicySet,
  loadSchema,
  ownershipPolicy,
  PolicyEngine,
  policyDataSchema,
  ROLE_TEMPLATES,
  roleTemplatePolicies,
  visibilityPolicies,
} from '../src';
import { cedar, validateStrict } from '../src/cedar';
import { data } from './fixtures';

const text = (entries: Array<{ text: string }>) => entries.map((e) => e.text);

describe('10.2 schema', () => {
  it('10.2 the stored JSON schema parses and round-trips to the documented entities and actions', () => {
    const schema = loadSchema();
    expect(cedar.checkParseSchema(schema).type).toBe('success');
    const rendered = cedar.schemaToText(schema);
    expect(rendered.type).toBe('success');
    if (rendered.type !== 'success') return;
    for (const entity of [
      'entity Org',
      'entity Team in [Org]',
      'entity User in [Team, Org]',
      'entity ServiceAccount in [Team, Org]',
      'entity CatalogEntry in [Org]',
      'entity Installation in [CatalogEntry]',
      'entity Tool in [Installation]',
      'entity Prompt in [Installation]',
      'entity Resource in [Installation]',
      'entity Endpoint',
      'entity ToolCall tags',
      'type McpContext',
    ]) {
      expect(rendered.text, entity).toContain(entity);
    }
    for (const action of [
      'useInstallation',
      'seeTool',
      'callTool',
      'seePrompt',
      'getPrompt',
      'seeResource',
      'readResource',
      'subscribeResource',
      'complete',
      'seeCatalog',
      'catalog.create',
      'catalog.update',
      'catalog.publish',
      'catalog.delete',
      'marketplace.manage',
      'plugin.approveExecutable',
      'installation.manage',
      'override.edit',
      'policy.edit',
      'guard.edit',
      'user.manage',
      'team.manage',
      'registry.install',
      'logs.view',
      'audit.view',
      'settings.edit',
      'secrets.manage',
    ]) {
      expect(rendered.text, action).toContain(`action "${action}"`);
    }
  });

  it('10.2 loadSchema returns an independent copy', () => {
    const a = loadSchema();
    (a as unknown as Record<string, unknown>).Mutated = true;
    expect(loadSchema()).not.toHaveProperty('Mutated');
  });
});

describe('10.3 role templates', () => {
  it('10.3 templates/*.cedar are identical to the string constants bundlers use', () => {
    const dir = join(__dirname, '..', 'templates');
    const files = readdirSync(dir).filter((f) => f.endsWith('.cedar'));
    expect(files.sort()).toEqual(
      Object.keys(ROLE_TEMPLATES)
        .map((k) => `${k}.cedar`)
        .sort(),
    );
    for (const file of files) {
      const key = file.replace('.cedar', '') as keyof typeof ROLE_TEMPLATES;
      expect(readFileSync(join(dir, file), 'utf8')).toBe(ROLE_TEMPLATES[key]);
    }
  });

  it('10.3 every role policy passes strict validation and has a unique id', () => {
    const entries = roleTemplatePolicies();
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    const outcome = validateStrict(Object.fromEntries(entries.map((e) => [e.id, e.text])));
    expect(outcome).toEqual({ ok: true });
  });

  it('10.1 data-driven role policies: manager call-log visibility and org-wide publishers', () => {
    const on = dataDrivenRolePolicies({
      settings: { logsManagerVisibility: true },
      orgWidePublisherIds: ['u1', 'u2'],
    });
    expect(on.map((p) => p.id)).toEqual([
      'role.manager.logs-team',
      'role.manager.logs-user',
      'role.manager.publish-org',
    ]);
    expect(on[2]?.text).toBe(
      '@id("role.manager.publish-org")\n' +
        'permit (principal is Bastion::User, action == Bastion::Action::"catalog.publish", resource is Bastion::Org)\n' +
        'when { (principal == Bastion::User::"u1" || principal == Bastion::User::"u2") };',
    );
    expect(
      dataDrivenRolePolicies({
        settings: { logsManagerVisibility: false },
        orgWidePublisherIds: [],
      }),
    ).toEqual([]);
    expect(
      dataDrivenRolePolicies({
        settings: { logsManagerVisibility: false },
        orgWidePublisherIds: ['u1'],
      })[0]?.text,
    ).toContain('when { principal == Bastion::User::"u1" }');
    expect(validateStrict(Object.fromEntries(on.map((p) => [p.id, p.text])))).toEqual({ ok: true });
  });
});

describe('10.3 visibility and ownership policies', () => {
  it('10.3 org visibility compiles to one permit for every principal of the org (golden)', () => {
    const out = visibilityPolicies(
      { id: 'e1', visibility: { org: true, teamIds: [], userIds: [] }, risk: 'low' },
      'org',
    );
    expect(text(out)).toEqual([
      '@id("visibility-e1-org")\npermit (principal in Bastion::Org::"org", action in [Bastion::Action::"seeCatalog", Bastion::Action::"installation.manage"], resource == Bastion::CatalogEntry::"e1");',
    ]);
  });

  it('10.3 team and user visibility compile to separate permits (golden)', () => {
    const out = visibilityPolicies(
      {
        id: 'e1',
        visibility: { org: false, teamIds: ['a', 'b'], userIds: ['u1'] },
        risk: 'low',
      },
      'org',
    );
    expect(text(out)).toEqual([
      '@id("visibility-e1-teams")\npermit (principal, action in [Bastion::Action::"seeCatalog", Bastion::Action::"installation.manage"], resource == Bastion::CatalogEntry::"e1")\nwhen { (principal in Bastion::Team::"a" || principal in Bastion::Team::"b") };',
      '@id("visibility-e1-users")\npermit (principal, action in [Bastion::Action::"seeCatalog", Bastion::Action::"installation.manage"], resource == Bastion::CatalogEntry::"e1")\nwhen { principal in Bastion::User::"u1" };',
    ]);
  });

  it('10.3 a private entry (empty visibility) compiles to no visibility policy', () => {
    expect(
      visibilityPolicies(
        { id: 'e1', visibility: { org: false, teamIds: [], userIds: [] }, risk: 'low' },
        'org',
      ),
    ).toEqual([]);
  });

  it('10.3 installation ownership: user, team and service owners (golden)', () => {
    const actions =
      '[Bastion::Action::"useInstallation", Bastion::Action::"callTool", Bastion::Action::"getPrompt", Bastion::Action::"readResource", Bastion::Action::"subscribeResource", Bastion::Action::"complete", Bastion::Action::"seeTool", Bastion::Action::"seePrompt", Bastion::Action::"seeResource"]';
    expect(ownershipPolicy({ id: 'i1', catalogEntryId: 'e1', ownerUserId: 'u1' })?.text).toBe(
      `@id("use-i1")\npermit (principal == Bastion::User::"u1", action in ${actions}, resource in Bastion::Installation::"i1");`,
    );
    expect(ownershipPolicy({ id: 'i2', catalogEntryId: 'e1', ownerTeamId: 't1' })?.text).toBe(
      `@id("use-i2")\npermit (principal is Bastion::User in Bastion::Team::"t1", action in ${actions}, resource in Bastion::Installation::"i2");`,
    );
    expect(ownershipPolicy({ id: 'i3', catalogEntryId: 'e1', ownerServiceId: 's1' })?.text).toBe(
      `@id("use-i3")\npermit (principal == Bastion::ServiceAccount::"s1", action in ${actions}, resource in Bastion::Installation::"i3");`,
    );
    expect(ownershipPolicy({ id: 'i4', catalogEntryId: 'e1' })).toBeNull();
  });

  it('10.3 ids that could break out of @id are rejected', () => {
    expect(() => ownershipPolicy({ id: 'i"1', catalogEntryId: 'e1', ownerUserId: 'u' })).toThrow();
    expect(() =>
      visibilityPolicies(
        { id: 'e"1', visibility: { org: true, teamIds: [], userIds: [] }, risk: 'low' },
        'org',
      ),
    ).toThrow();
  });
});

describe('10.3 tool rules', () => {
  it('10.3 reproduces the first compiled example byte for byte', () => {
    const out = compileRule({
      id: '0192d3',
      effect: 'forbid',
      who: { teams: ['contractors'] },
      what: { annotations: { destructive: true } },
      when: {},
    });
    const call = out.find((p) => p.id === 'rule-0192d3');
    expect(call?.text).toBe(
      '@id("rule-0192d3")\n' +
        'forbid (principal in Bastion::Team::"contractors", action == Bastion::Action::"callTool", resource)\n' +
        'when { resource.destructive };',
    );
  });

  it('10.3 reproduces the second compiled example byte for byte', () => {
    const out = compileRule({
      id: '0192d4',
      effect: 'forbid',
      who: {},
      what: { toolName: 'delete_repository' },
      when: { args: [{ op: 'ne', name: 'owner', value: 'acme-sandbox' }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe(
      '@id("rule-0192d4")\n' +
        'forbid (principal, action == Bastion::Action::"callTool", resource)\n' +
        'when { resource.name == "delete_repository" && context has call && context.call.hasTag("owner") && context.call.getTag("owner") != "acme-sandbox" };',
    );
  });

  it('10.3 a row with no when conditions compiles to a seeTool and a callTool policy', () => {
    const out = compileRule({
      id: 'abc',
      effect: 'forbid',
      who: { teams: ['contractors'] },
      what: { annotations: { destructive: true } },
      when: {},
    });
    expect(out.map((p) => p.id)).toEqual(['rule-abc.see', 'rule-abc']);
    expect(out[0]?.text).toContain('action == Bastion::Action::"seeTool"');
    expect(out[1]?.text).toContain('action == Bastion::Action::"callTool"');
  });

  it('10.3 a row with an empty when object still counts as having no conditions', () => {
    const out = compileRule({
      id: 'abc',
      effect: 'permit',
      who: {},
      what: {},
      when: { clientIds: [], weekdays: [], ipCidrs: [], args: [] },
    });
    expect(out).toHaveLength(2);
  });

  it('10.3 a row with any when condition compiles to a callTool policy only (golden)', () => {
    const out = compileRule({
      id: 'w1',
      effect: 'forbid',
      who: { role: 'member' },
      what: {
        installationId: 'i1',
        toolName: 'delete_*',
        annotations: { readOnly: false, openWorld: true },
      },
      when: {
        clientIds: ['a', 'b'],
        hours: { from: 22, to: 6 },
        weekdays: [0, 6],
        ipCidrs: ['10.0.0.0/8', '192.168.0.0/16'],
        args: [
          { op: 'in', name: 'env', values: ['prod', 'stage'] },
          { op: 'exists', name: 'force' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe(
      '@id("rule-w1")\n' +
        'forbid (principal is Bastion::User, action == Bastion::Action::"callTool", resource in Bastion::Installation::"i1")\n' +
        'when { principal.role == "member" && resource.name like "delete_*" && !resource.readOnly && resource.openWorld && ["a", "b"].contains(context.clientId) && (context.hour >= 22 || context.hour < 6) && [0, 6].contains(context.weekday) && (context.ip.isInRange(ip("10.0.0.0/8")) || context.ip.isInRange(ip("192.168.0.0/16"))) && context has call && context.call.hasTag("env") && ["prod", "stage"].contains(context.call.getTag("env")) && context.call.hasTag("force") };',
    );
    expect(validateStrict({ [out[0]?.id ?? '']: out[0]?.text ?? '' })).toEqual({ ok: true });
  });

  it('10.3 who selectors: single user, several teams, mixed selectors, manager role', () => {
    const one = compileRule({
      id: 'a',
      effect: 'permit',
      who: { users: ['u1'] },
      what: {},
      when: {},
    });
    expect(one[1]?.text).toContain('permit (principal == Bastion::User::"u1", action');
    const sa = compileRule({
      id: 'a',
      effect: 'permit',
      who: { serviceAccounts: ['s1'] },
      what: {},
      when: {},
    });
    expect(sa[1]?.text).toContain('principal == Bastion::ServiceAccount::"s1"');
    const teams = compileRule({
      id: 'a',
      effect: 'forbid',
      who: { teams: ['x', 'y'] },
      what: {},
      when: {},
    });
    expect(teams[1]?.text).toContain(
      'forbid (principal, action == Bastion::Action::"callTool", resource)\nwhen { (principal in Bastion::Team::"x" || principal in Bastion::Team::"y") };',
    );
    const mixed = compileRule({
      id: 'a',
      effect: 'forbid',
      who: { role: 'manager', users: ['u1'] },
      what: {},
      when: {},
    });
    expect(mixed[1]?.text).toContain(
      '((principal is Bastion::User && !principal.managedTeams.isEmpty()) || principal in Bastion::User::"u1")',
    );
    for (const policy of [...one, ...sa, ...teams, ...mixed]) {
      expect(validateStrict({ [policy.id]: policy.text })).toEqual({ ok: true });
    }
  });

  it('10.3 catalog entry scopes, both installation and entry, and every argument operator', () => {
    const out = compileRule({
      id: 'b',
      effect: 'forbid',
      who: {},
      what: { catalogEntryId: 'e1', toolName: '*' },
      when: { hours: { from: 9, to: 17 } },
    });
    expect(out[0]?.text).toBe(
      '@id("rule-b")\nforbid (principal, action == Bastion::Action::"callTool", resource in Bastion::CatalogEntry::"e1")\nwhen { (context.hour >= 9 && context.hour < 17) };',
    );
    const both = compileRule({
      id: 'c',
      effect: 'forbid',
      who: {},
      what: { catalogEntryId: 'e1', installationId: 'i1' },
      when: {
        hours: { from: 9, to: 24 },
        args: [
          { op: 'eq', name: 'a', value: 'x' },
          { op: 'like', name: 'b', pattern: 'pre*' },
          { op: 'notExists', name: 'c' },
        ],
      },
    });
    expect(both[0]?.text).toBe(
      '@id("rule-c")\nforbid (principal, action == Bastion::Action::"callTool", resource in Bastion::Installation::"i1")\nwhen { resource in Bastion::CatalogEntry::"e1" && context.hour >= 9 && context has call && context.call.hasTag("a") && context.call.getTag("a") == "x" && context.call.hasTag("b") && context.call.getTag("b") like "pre*" && !context.call.hasTag("c") };',
    );
    expect(validateStrict({ c: both[0]?.text ?? '', b: out[0]?.text ?? '' })).toEqual({ ok: true });
  });

  it('10.3 rejects unsupported globs and degenerate hours', () => {
    expect(() =>
      compileRule({ id: 'a', effect: 'forbid', who: {}, what: { toolName: 'a?*' }, when: {} }),
    ).toThrow(/wildcard/);
    expect(() =>
      compileRule({
        id: 'a',
        effect: 'forbid',
        who: {},
        what: {},
        when: { hours: { from: 5, to: 5 } },
      }),
    ).toThrow(/differ/);
    expect(() =>
      compileRule({ id: 'a b', effect: 'forbid', who: {}, what: {}, when: {} }),
    ).toThrow();
    expect(() =>
      compileRule({
        id: 'a',
        effect: 'forbid',
        who: {},
        what: {},
        when: { ipCidrs: ['1.2.3.4") || true //'] },
      }),
    ).toThrow();
  });
});

describe('10.3 Cedar injection safety', () => {
  const hostile = [
    '"; permit (principal, action, resource); //',
    'x\\" || true || \\"',
    'back\\slash',
    '\n\r\t\u0000\u0001',
    ['$', '{1+1} `tick` {braces}'].join(''),
    'unicode   😀 lone \ud800',
  ];

  it('10.3 escapeCedarString escapes quotes, backslashes and control characters', () => {
    expect(escapeCedarString('a"b\\c\nd\u0001')).toBe('a\\"b\\\\c\\nd\\u{1}');
    expect(escapeCedarString('\ud800')).toBe('�');
  });

  for (const value of hostile) {
    it(`10.3 a rule value cannot break out of its string: ${JSON.stringify(value).slice(0, 40)}`, () => {
      const out = compileRule({
        id: 'inj',
        effect: 'forbid',
        who: { teams: [value], users: [value], serviceAccounts: [value] },
        what: {
          installationId: value,
          catalogEntryId: value,
          toolName: value.replace(/[?[\]{}]/g, ''),
        },
        when: {
          clientIds: [value],
          args: [
            { op: 'eq', name: value, value },
            { op: 'in', name: value, values: [value, value] },
          ],
        },
      });
      expect(out).toHaveLength(1);
      const policy = out[0];
      if (!policy) throw new Error('no policy');
      // Exactly one policy, annotated once, still a forbid: nothing escaped into Cedar syntax.
      const parts = cedar.policySetTextToParts(policy.text);
      expect(parts.type).toBe('success');
      if (parts.type !== 'success') return;
      expect(parts.policies).toHaveLength(1);
      const json = cedar.policyToJson(policy.text);
      expect(json.type).toBe('success');
      if (json.type !== 'success') return;
      expect(json.json.effect).toBe('forbid');
      expect(json.json.annotations).toEqual({ id: 'rule-inj' });
      expect(validateStrict({ inj: policy.text })).toEqual({ ok: true });
      expect(json.json.conditions).toHaveLength(1);
    });
  }

  it('10.3 property: arbitrary strings in who/what/when always compile to one strict-valid policy', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (value) => {
        const out = compileRule({
          id: 'p',
          effect: 'forbid',
          who: { teams: [value || 'x'] },
          what: { installationId: value || 'x' },
          when: { args: [{ op: 'ne', name: value || 'x', value }] },
        });
        const policy = out[0];
        if (!policy) return false;
        const parts = cedar.policySetTextToParts(policy.text);
        return (
          parts.type === 'success' &&
          parts.policies.length === 1 &&
          validateStrict({ p: policy.text }).ok
        );
      }),
      { numRuns: 60 },
    );
  });

  it('10.3 an injected tool-call argument value cannot change how a rule behaves at evaluation time', () => {
    const engine = PolicyEngine.create(
      data({
        rules: [
          {
            id: 'r1',
            effect: 'forbid',
            who: {},
            what: { toolName: 'delete_repository' },
            when: { args: [{ op: 'ne', name: 'owner', value: 'acme"sandbox' }] },
          },
        ],
      }),
    );
    expect(engine.policyIds()).toContain('rule-r1');
  });
});

describe('10.3 the effective set', () => {
  it('10.3 generatePolicySet is deterministic and strict-valid end to end', () => {
    const d = policyDataSchema.parse(
      data({
        orgWidePublisherIds: ['u1'],
        rules: [
          {
            id: 'r1',
            effect: 'forbid',
            who: { teams: ['t'] },
            what: { annotations: { destructive: true } },
          },
          {
            id: 'r2',
            effect: 'permit',
            who: { role: 'auditor' },
            what: { toolName: 'list_*' },
            when: { weekdays: [1] },
          },
        ],
      }),
    );
    const a = generatePolicySet(d);
    const b = generatePolicySet(d);
    expect(a).toEqual(b);
    expect(new Set(a.map((p) => p.id)).size).toBe(a.length);
    expect(validateStrict(Object.fromEntries(a.map((p) => [p.id, p.text])))).toEqual({ ok: true });
  });
});
