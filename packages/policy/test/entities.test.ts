import { describe, expect, it } from 'vitest';
import {
  buildContext,
  buildToolCallEntity,
  clockContext,
  deriveToolFlags,
  loadSchema,
  MAX_TAG_VALUE_LENGTH,
  MAX_TAGS,
  principalSlice,
  resourceSlice,
} from '../src';
import { cedar } from '../src/cedar';
import { mergeEntities, visibilitySummary } from '../src/entities';
import {
  admin,
  context,
  entryResource,
  instService,
  instTeam,
  manager,
  member,
  ORG,
  orgResource,
  prompt,
  resource,
  serviceAccount,
  teamResource,
  tool,
  userResource,
} from './fixtures';

describe('10.2 tool flags', () => {
  it('10.2 missing hints use the MCP defaults (readOnly false, destructive true, openWorld true)', () => {
    expect(deriveToolFlags(undefined)).toEqual({
      readOnly: false,
      destructive: true,
      openWorld: true,
    });
    expect(deriveToolFlags({})).toEqual({ readOnly: false, destructive: true, openWorld: true });
  });

  it('10.2 explicit hints override the defaults', () => {
    expect(
      deriveToolFlags({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    ).toEqual({ readOnly: true, destructive: false, openWorld: false });
  });
});

describe('10.2 ToolCall entity', () => {
  it('10.2 top-level scalar arguments become String tags', () => {
    const e = buildToolCallEntity({
      owner: 'acme',
      n: 3,
      ok: true,
      big: 10n,
      nested: { a: 1 },
      list: [1],
      none: null,
    });
    expect(e.tags).toEqual({ owner: 'acme', n: '3', ok: 'true', big: '10' });
    expect(e.uid).toEqual({ type: 'Bastion::ToolCall', id: 'call' });
  });

  it('10.2 strings are capped at 256 characters', () => {
    const e = buildToolCallEntity({ s: 'x'.repeat(1000) });
    expect(e.tags?.s).toHaveLength(MAX_TAG_VALUE_LENGTH);
  });

  it('10.2 non-finite numbers and over-long names are skipped, the tag count is bounded', () => {
    const args: Record<string, unknown> = {
      inf: Number.POSITIVE_INFINITY,
      [`${'k'.repeat(200)}`]: 'v',
      '': 'e',
    };
    for (let i = 0; i < 200; i += 1) args[`a${i}`] = 'v';
    const e = buildToolCallEntity(args);
    expect(Object.keys(e.tags ?? {})).toHaveLength(MAX_TAGS);
    expect(e.tags).not.toHaveProperty('inf');
    expect(buildToolCallEntity(undefined).tags).toEqual({});
  });
});

describe('10.4 entity slices', () => {
  it('10.4 the principal slice carries its teams, managed teams and the org as ancestors', () => {
    const slice = principalSlice(manager, ORG);
    const user = slice.entities[0];
    expect(user?.uid).toEqual({ type: 'Bastion::User', id: 'mgr1' });
    expect(user?.attrs).toMatchObject({ role: 'member', active: true });
    expect(user?.attrs.managedTeams).toEqual([{ __entity: { type: 'Bastion::Team', id: 't' } }]);
    expect(slice.ancestors).toHaveLength(3);
    const sa = principalSlice(serviceAccount, ORG);
    expect(sa.entities.map((e) => e.uid)).toContainEqual({
      type: 'Bastion::ServiceAccount',
      id: 'sa1',
    });
  });

  it('10.4 resource slices include the resource and its ancestors up to the org', () => {
    const t = resourceSlice(tool(instTeam, 'x'), ORG);
    expect(t.entities.map((e) => 'type' in e.uid && e.uid.type)).toEqual([
      'Bastion::Tool',
      'Bastion::Installation',
      'Bastion::CatalogEntry',
    ]);
    expect(t.ancestors).toHaveLength(4);
    const withService = resourceSlice(tool(instService, 'x'), ORG);
    expect(withService.entities.map((e) => 'type' in e.uid && e.uid.type)).toContain(
      'Bastion::ServiceAccount',
    );
  });

  it('10.4 mergeEntities keeps the first occurrence of an entity', () => {
    const a = resourceSlice(tool(instTeam, 'x'), ORG).entities;
    const b = resourceSlice(tool(instTeam, 'y'), ORG).entities;
    const merged = mergeEntities([a, b]);
    expect(merged).toHaveLength(4);
  });

  it('11.1 visibilitySummary derives org, restricted or private', () => {
    expect(visibilitySummary({ org: true, teamIds: [], userIds: [] })).toBe('org');
    expect(visibilitySummary({ org: false, teamIds: ['t'], userIds: [] })).toBe('restricted');
    expect(visibilitySummary({ org: false, teamIds: [], userIds: ['u'] })).toBe('restricted');
    expect(visibilitySummary(undefined)).toBe('private');
  });

  it('10.2 every entity and context the engine builds validates against the schema', () => {
    const schema = loadSchema();
    const resources = [
      orgResource(),
      teamResource('t'),
      userResource('mem1', ['t']),
      entryResource('e1', { ownerTeamId: 't', visibility: { org: true }, risk: 'high' }),
      tool(instTeam, 'x', { readOnlyHint: true }),
      tool(instService, 'x'),
      prompt(instTeam, 'p'),
      resource(instTeam, 'file:///a'),
    ];
    for (const principal of [admin, manager, member, serviceAccount]) {
      for (const r of resources) {
        const entities = mergeEntities([
          principalSlice(principal, ORG).entities,
          resourceSlice(r, ORG).entities,
          [buildToolCallEntity({ a: 'b' })],
        ]);
        expect(cedar.checkParseEntities({ entities, schema }), `${principal.id} ${r.type}`).toEqual(
          { type: 'success' },
        );
      }
    }
    const ctx = buildContext(context, true);
    expect(
      cedar.checkParseContext({
        context: ctx,
        schema,
        action: { type: 'Bastion::Action', id: 'callTool' },
      }),
    ).toEqual({ type: 'success' });
    const noCall = buildContext(context, false);
    expect(
      cedar.checkParseContext({
        context: noCall,
        schema,
        action: { type: 'Bastion::Action', id: 'seeTool' },
      }),
    ).toEqual({ type: 'success' });
  });

  it('10.2 a fully schema-validated request is accepted by Cedar (request validation on)', () => {
    const p = principalSlice(member, ORG);
    const r = resourceSlice(tool(instTeam, 'x'), ORG);
    const answer = cedar.isAuthorized({
      principal: p.uid,
      action: { type: 'Bastion::Action', id: 'callTool' },
      resource: r.uid,
      context: buildContext(context, true),
      schema: loadSchema(),
      validateRequest: true,
      policies: { staticPolicies: {} },
      entities: mergeEntities([p.entities, r.entities, [buildToolCallEntity({ a: 'b' })]]),
    });
    expect(answer.type).toBe('success');
  });
});

describe('10.3 request context helpers', () => {
  it('10.3 clockContext returns the hour and weekday (0 = Sunday) in the time zone', () => {
    const instant = new Date('2026-10-01T23:30:00Z'); // Thursday UTC
    expect(clockContext(instant)).toEqual({ hour: 23, weekday: 4 });
    expect(clockContext(instant, 'Asia/Tokyo')).toEqual({ hour: 8, weekday: 5 });
    expect(clockContext(new Date('2026-10-04T00:05:00Z'))).toEqual({ hour: 0, weekday: 0 });
  });
});
