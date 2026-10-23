import { type OverridesInput, overridesSchema } from '@bastion-mcp/overrides';
import { describe, expect, it } from 'vitest';
import {
  assembleEndpoint,
  type CompileInput,
  compileEndpoint,
  type EndpointPolicy,
  resolveResourceUri,
  selectInstallations,
  serializeEndpoint,
  type UpstreamItemSource,
  type UpstreamItems,
  type UpstreamListResult,
  UpstreamProvider,
} from '../src';
import { engineFor, installation, items, principal, requestContext, tool } from './helpers';

const doc = (o: Partial<OverridesInput>) => overridesSchema.parse({ version: 1, ...o });

const sourceOf = (
  map: Record<string, UpstreamItems | UpstreamListResult | Error>,
): UpstreamItemSource => ({
  async listItems(inst) {
    const v = map[inst.id];
    if (v instanceof Error) throw v;
    if (!v) return { status: 'degraded', code: 'unavailable' };
    if ('status' in v) return v;
    return { status: 'ok', items: v, origin: 'cache' };
  },
});

const base = (
  installations: ReturnType<typeof installation>[],
  map: Record<string, UpstreamItems | UpstreamListResult | Error>,
  over: Partial<CompileInput> = {},
): CompileInput => ({
  principal,
  endpoint: { id: 'default', kind: 'default', prefixMode: 'always' },
  installations,
  source: sourceOf(map),
  policy: engineFor(installations),
  requestContext,
  org: { displayName: 'Acme' },
  serverVersion: '1.2.3',
  configVersion: '1',
  ...over,
});

const names = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name);

describe('7.2 collecting installations', () => {
  const a = installation({ id: 'a', slug: 'alpha', displayName: 'Zeta' });
  const b = installation({ id: 'b', slug: 'beta', displayName: 'Alpha', pinned: false });
  const c = installation({ id: 'c', slug: 'gamma', displayName: 'Mid', pinned: true });
  const team = installation({
    id: 't',
    slug: 'shared',
    displayName: 'Team',
    owner: { kind: 'team', id: 't1', slug: 'eng' },
  });

  it('7.2 default endpoint: pinned first, then by display name', () => {
    const sel = selectInstallations({
      principal,
      endpoint: base([], {}).endpoint,
      installations: [a, b, c],
    });
    expect(sel.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('7.2 named endpoint keeps endpoint order and skips unknown ids', () => {
    const sel = selectInstallations({
      principal,
      endpoint: {
        id: 'e',
        kind: 'named',
        prefixMode: 'always',
        installationIds: ['a', 'zz', 'b', 'a'],
      },
      installations: [a, b, c],
    });
    expect(sel.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('11.3 the hidden installation of a catalog test is served on its own endpoint only', () => {
    const test = installation({ id: 'tt', slug: 'test-1a2b', displayName: 'Test of Alpha' });
    const marked = { ...test, origin: 'test' };
    const installations = [a, marked];
    const pick = (endpoint: Parameters<typeof selectInstallations>[0]['endpoint']) =>
      selectInstallations({ principal, endpoint, installations }).map((i) => i.id);
    // Default, named and catalog endpoints never include it, even when it is enabled and asked for by id.
    expect(pick(base([], {}).endpoint)).toEqual(['a']);
    expect(
      pick({ id: 'e', kind: 'named', prefixMode: 'always', installationIds: ['tt', 'a'] }),
    ).toEqual(['a']);
    expect(
      pick({
        id: 'c',
        kind: 'catalog',
        slug: 'alpha',
        prefixMode: 'always',
        installationIds: ['tt'],
      }),
    ).toEqual([]);
    // Its own endpoint (what the Test step connects to) still serves it.
    expect(
      pick({
        id: 'i',
        kind: 'installation',
        slug: 'test-1a2b',
        prefixMode: 'onCollision',
        installationIds: ['tt'],
      }),
    ).toEqual(['tt']);
  });

  it('11.4 includes team installations the user belongs to, honoring installation_prefs.hidden', () => {
    const endpoint = base([], {}).endpoint;
    expect(
      selectInstallations({ principal, endpoint, installations: [a, team] }).map((i) => i.id),
    ).toContain('t');
    expect(
      selectInstallations({
        principal,
        endpoint,
        installations: [a, team],
        hiddenInstallationIds: ['t'],
      }).map((i) => i.id),
    ).toEqual(['a']);
    const other = installation({
      id: 'o',
      slug: 'other',
      owner: { kind: 'team', id: 'zzz', slug: 'zz' },
    });
    const foreign = installation({
      id: 'f',
      slug: 'foreign',
      owner: { kind: 'user', id: 'someone' },
    });
    expect(selectInstallations({ principal, endpoint, installations: [other, foreign] })).toEqual(
      [],
    );
  });

  it('11.4 hiding does not apply to an explicit single-installation endpoint', () => {
    const sel = selectInstallations({
      principal,
      endpoint: {
        id: 'i',
        kind: 'installation',
        prefixMode: 'onCollision',
        installationIds: ['t'],
      },
      installations: [team],
      hiddenInstallationIds: ['t'],
    });
    expect(sel).toHaveLength(1);
  });

  it('11.4 excludes disabled, needs_setup and not-enabled installations; keeps reconnect_required', () => {
    const endpoint = base([], {}).endpoint;
    const list = [
      installation({ id: '1', slug: 'one', enabled: false }),
      installation({ id: '2', slug: 'two', status: 'needs_setup' }),
      installation({ id: '3', slug: 'three', status: 'disabled' }),
      installation({ id: '4', slug: 'four', status: 'reconnect_required' }),
    ];
    expect(
      selectInstallations({ principal, endpoint, installations: list }).map((i) => i.id),
    ).toEqual(['4']);
  });

  it('7.2 service principals and service-owned installations are collected', () => {
    const svc = { kind: 'service' as const, id: 'sa', active: true, team: { id: 't1' } };
    const own = installation({ id: 's', slug: 'svc', owner: { kind: 'service', id: 'sa' } });
    const viaTeam = installation({
      id: 'v',
      slug: 'via',
      owner: { kind: 'service', id: 'x', teamId: 't1' },
    });
    const sel = selectInstallations({
      principal: svc,
      endpoint: base([], {}).endpoint,
      installations: [own, viaTeam, a],
    });
    expect(sel.map((i) => i.id).sort()).toEqual(['s', 'v']);
  });

  it('7.2 drops installations Cedar does not allow (useInstallation)', async () => {
    const list = [a, b];
    const policy: EndpointPolicy = {
      authorize: (r) => ({
        decision: r.resource.type === 'Installation' && r.resource.id === 'a' ? 'deny' : 'allow',
        reasons: [],
        errors: [],
      }),
      filterVisible: (_r, i) => ({ visible: [...i], hidden: [] }),
    };
    const r = await compileEndpoint(
      base(
        list,
        { a: items({ tools: [tool('x')] }), b: items({ tools: [tool('y')] }) },
        { policy },
      ),
    );
    expect(names(r)).toEqual(['beta__y']);
  });
});

describe('7.3 naming', () => {
  const a = installation({ id: 'a', slug: 'git-hub', displayName: 'A' });
  const b = installation({ id: 'b', slug: 'jira', displayName: 'B' });
  const map = {
    a: items({ tools: [tool('search'), tool('only_a')] }),
    b: items({ tools: [tool('search'), tool('bad name!')] }),
  };

  it('7.3 prefixMode always prefixes with the slug (- becomes _) and sanitizes', async () => {
    const r = await compileEndpoint(base([a, b], map));
    expect(names(r)).toEqual([
      'git_hub__only_a',
      'git_hub__search',
      'jira__bad_name_',
      'jira__search',
    ]);
    expect(r.prefixing).toBe(true);
    expect(r.collisions).toEqual([]);
  });

  it('7.3 prefixMode onCollision prefixes only colliding names and flags both installations', async () => {
    const r = await compileEndpoint(
      base([a, b], map, {
        endpoint: {
          id: 'e',
          kind: 'named',
          prefixMode: 'onCollision',
          installationIds: ['a', 'b'],
        },
      }),
    );
    expect(names(r)).toEqual(['bad_name_', 'git_hub__search', 'jira__search', 'only_a']);
    expect(r.collisions).toEqual([{ kind: 'tool', name: 'search', installationIds: ['a', 'b'] }]);
    expect(r.installations.map((i) => i.collisionCount)).toEqual([1, 1]);
    expect(r.items.filter((i) => i.kind === 'tool' && i.collided).map((i) => i.finalKey)).toEqual([
      'git_hub__search',
      'jira__search',
    ]);
  });

  it('7.3 exact override names suppress prefixing; the higher-priority installation keeps a contested name', async () => {
    const aa = installation({
      id: 'a',
      slug: 'a1',
      layers: { installation: doc({ tools: { search: { name: 'find' } } }) },
    });
    const bb = installation({
      id: 'b',
      slug: 'b1',
      layers: { installation: doc({ tools: { search: { name: 'find' } } }) },
    });
    const r = await compileEndpoint(
      base(
        [aa, bb],
        { a: items({ tools: [tool('search')] }), b: items({ tools: [tool('search')] }) },
        {
          endpoint: { id: 'e', kind: 'named', prefixMode: 'always', installationIds: ['b', 'a'] },
        },
      ),
    );
    expect(names(r)).toEqual(['find', 'find_2']);
    expect(r.toolRoutes.get('find')?.installationId).toBe('b');
    expect(r.toolRoutes.get('find_2')?.installationId).toBe('a');
    expect(r.collisions).toEqual([{ kind: 'tool', name: 'find', installationIds: ['a', 'b'] }]);
  });

  it('7.3 single-installation and catalog endpoints never prefix', async () => {
    for (const kind of ['installation', 'catalog'] as const) {
      const r = await compileEndpoint(
        base([a, b], map, {
          endpoint: { id: 'i', kind, prefixMode: 'always', installationIds: ['a'] },
        }),
      );
      expect(names(r)).toEqual(['only_a', 'search']);
      expect(r.prefixing).toBe(false);
    }
  });

  it('7.3 title and description pass through unchanged and prompts are named the same way', async () => {
    const r = await compileEndpoint(
      base([a], {
        a: items({
          tools: [tool('t', { title: 'T' })],
          prompts: [{ name: 'p', description: 'd' }],
        }),
      }),
    );
    expect(r.tools[0]).toMatchObject({ title: 'T', description: 't description' });
    expect(r.prompts[0]).toMatchObject({ name: 'git_hub__p', description: 'd' });
    expect(r.promptRoutes.get('git_hub__p')).toMatchObject({
      upstreamName: 'p',
      installationId: 'a',
    });
  });
});

describe('7.2 overrides and routing', () => {
  it('7.2 hidden items are removed and routing maps reverse the rename with the plan', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: {
        catalog: doc({
          tools: { secret: { hidden: true }, send: { pinnedArguments: { channel: 'C1' } } },
        }),
        installation: doc({ tools: { send: { description: 'Send it' } } }),
      },
    });
    const r = await compileEndpoint(
      base([a], {
        a: items({
          tools: [
            tool('secret'),
            tool('send', {
              inputSchema: { type: 'object', properties: { channel: { type: 'string' } } },
            }),
          ],
        }),
      }),
    );
    expect(names(r)).toEqual(['a1__send']);
    const route = r.toolRoutes.get('a1__send');
    expect(route).toMatchObject({ installationId: 'a', upstreamName: 'send' });
    expect(route?.plan?.pinned).toEqual({ channel: 'C1' });
    expect(r.tools[0]?.description).toBe('Send it');
    expect(r.items.find((i) => i.upstreamKey === 'send')?.overridden).toBe(true);
    expect(r.toolRoutes.has('a1__secret')).toBe(false);
  });

  it('12.1 a catalog-layer pinned argument cannot be overridden by a user-layer override, even at full level', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: {
        catalog: doc({ tools: { send: { pinnedArguments: { channel: 'C1' } } } }),
        installation: doc({
          tools: { send: { pinnedArguments: { channel: 'EVIL', extra: 1 } } },
        }),
      },
    });
    const r = await compileEndpoint(base([a], { a: items({ tools: [tool('send')] }) }));
    const plan = r.toolRoutes.get('a1__send')?.plan;
    expect(plan?.pinned).toEqual({ channel: 'C1', extra: 1 });
    expect(plan?.validate).toBe(true);
    expect(r.items[0]?.issues.map((i) => i.code)).toContain('catalog_pin_enforced');
  });

  it('12.1 catalog-pinned prompt arguments are enforced the same way', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: {
        catalog: doc({ prompts: { p: { arguments: { lang: { pinned: 'en' } } } } }),
        installation: doc({ prompts: { p: { arguments: { lang: { pinned: 'xx' } } } } }),
      },
    });
    const r = await compileEndpoint(
      base([a], { a: items({ prompts: [{ name: 'p', arguments: [{ name: 'lang' }] }] }) }),
    );
    expect(r.promptRoutes.get('a1__p')?.plan?.pinned).toEqual({ lang: 'en' });
  });

  it('12.3 an invalid schema patch serves the tool without it and flags it', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: {
        installation: doc({
          tools: {
            t: {
              inputSchemaPatch: [{ op: 'replace', path: '/properties/nope/type', value: 'string' }],
            },
          },
        }),
      },
    });
    const r = await compileEndpoint(base([a], { a: items({ tools: [tool('t')] }) }));
    expect(names(r)).toEqual(['a1__t']);
    expect(r.items[0]?.invalidPatch).toBeDefined();
  });

  it('12.3 an item whose override is invalid is withheld and reported', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: { installation: doc({ tools: { t: { pinnedArguments: { x: '{{nope.x}}' } } } }) },
    });
    const r = await compileEndpoint(base([a], { a: items({ tools: [tool('t'), tool('ok')] }) }));
    expect(names(r)).toEqual(['a1__ok']);
    expect(r.warnings).toMatchObject([{ code: 'invalid_override', kind: 'tool', key: 't' }]);
  });

  it('12.3 prompts and resources honor hidden and invalid overrides', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: {
        installation: doc({
          prompts: { hide: { hidden: true }, bad: { arguments: { x: { pinned: '{{nope.x}}' } } } },
          resources: { 'file:///h': { hidden: true } },
          resourceTemplates: { 'f://{x}': { hidden: true } },
        }),
      },
    });
    const r = await compileEndpoint(
      base([a], {
        a: items({
          prompts: [{ name: 'hide' }, { name: 'bad' }, { name: 'ok' }],
          resources: [
            { uri: 'file:///h', name: 'h' },
            { uri: 'file:///v', name: 'v' },
          ],
          resourceTemplates: [{ uriTemplate: 'f://{x}', name: 'ft' }],
        }),
      }),
    );
    expect(r.prompts.map((p) => p.name)).toEqual(['a1__ok']);
    expect(r.resources.map((x) => x.uri)).toEqual(['file:///v']);
    expect(r.resourceTemplates).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['invalid_override']);
  });

  it('7.2 drops tools Cedar hides (seeTool) and decides on final annotations', async () => {
    const a = installation({
      id: 'a',
      slug: 'a1',
      layers: {
        installation: doc({ tools: { wipe: { annotations: { destructiveHint: true } } } }),
      },
    });
    const rules = [
      { id: 'r1', effect: 'forbid', what: { toolName: 'drop*' } },
      { id: 'r2', effect: 'forbid', what: { annotations: { destructive: true } } },
    ];
    const r = await compileEndpoint(
      base(
        [a],
        {
          a: items({
            tools: [
              tool('drop_all'),
              tool('wipe'),
              tool('read', { annotations: { readOnlyHint: true, destructiveHint: false } }),
            ],
          }),
        },
        { policy: engineFor([a], rules) },
      ),
    );
    expect(names(r)).toEqual(['a1__read']);
    expect(r.toolRoutes.has('a1__wipe')).toBe(false);
  });

  it('6.9 prompts and resources Cedar hides are removed from lists and the URI index', async () => {
    const a = installation({ id: 'a', slug: 'a1' });
    const policy: EndpointPolicy = {
      authorize: () => ({ decision: 'allow', reasons: [], errors: [] }),
      filterVisible: (_req, list) => ({
        visible: list.filter(
          (i) =>
            !(i.type === 'Prompt' && i.name === 'p2') &&
            !(i.type === 'Resource' && i.uri.includes('hide')),
        ),
        hidden: [],
      }),
    };
    const r = await compileEndpoint(
      base(
        [a],
        {
          a: items({
            prompts: [{ name: 'p1' }, { name: 'p2' }],
            resources: [
              { uri: 'f:///hide', name: 'h' },
              { uri: 'f:///ok', name: 'o' },
            ],
            resourceTemplates: [{ uriTemplate: 'g://{x}/hide', name: 't' }],
          }),
        },
        { policy },
      ),
    );
    expect(r.prompts.map((p) => p.name)).toEqual(['a1__p1']);
    expect(r.resources.map((x) => x.uri)).toEqual(['f:///ok']);
    expect(r.resourceTemplates).toEqual([]);
    expect(resolveResourceUri(r.uriIndex, 'f:///hide')).toEqual({ ok: false });
  });
});

describe('7.4 URI index in compiled endpoints', () => {
  it('7.4 duplicate URIs: the first installation owns it, the other is hidden and warned', async () => {
    const a = installation({ id: 'a', slug: 'a1', displayName: 'A' });
    const b = installation({ id: 'b', slug: 'b1', displayName: 'B' });
    const res = { resources: [{ uri: 'file:///x', name: 'x' }] };
    const r = await compileEndpoint(base([a, b], { a: items(res), b: items(res) }));
    expect(r.resources).toHaveLength(1);
    expect(resolveResourceUri(r.uriIndex, 'file:///x')).toMatchObject({
      target: { installationId: 'a' },
    });
    expect(r.warnings).toEqual([
      { code: 'uri_conflict', uri: 'file:///x', owner: 'a', hidden: 'b' },
    ]);
  });

  it('7.4 uriPrefix rewrites to bastion+{slug}: and routes with the prefix stripped', async () => {
    const a = installation({
      id: 'a',
      slug: 'fs-a',
      layers: { installation: doc({ uriPrefix: true }) },
    });
    const r = await compileEndpoint(
      base([a], {
        a: items({
          resources: [{ uri: 'file:///x', name: 'x' }],
          resourceTemplates: [{ uriTemplate: 'file:///{p}', name: 't' }],
        }),
      }),
    );
    expect(r.resources[0]?.uri).toBe('bastion+fs-a:file:///x');
    expect(r.resourceTemplates[0]?.uriTemplate).toBe('bastion+fs-a:file:///{p}');
    expect(resolveResourceUri(r.uriIndex, 'bastion+fs-a:file:///x')).toMatchObject({
      target: { installationId: 'a', upstreamUri: 'file:///x' },
    });
    expect(resolveResourceUri(r.uriIndex, 'bastion+fs-a:file:///other')).toMatchObject({
      target: { installationId: 'a', upstreamUri: 'file:///other' },
    });
  });

  it('7.4 templates route by endpoint order and MCP Apps ui resources are indexed through tool _meta', async () => {
    const a = installation({ id: 'a', slug: 'a1' });
    const r = await compileEndpoint(
      base([a], {
        a: items({
          tools: [tool('w', { _meta: { ui: { resourceUri: 'ui://widget' } } })],
          resourceTemplates: [{ uriTemplate: 'repo://{o}/{r}', name: 't' }],
        }),
      }),
    );
    expect(resolveResourceUri(r.uriIndex, 'ui://widget')).toMatchObject({
      target: { installationId: 'a' },
    });
    expect(resolveResourceUri(r.uriIndex, 'repo://x/y')).toMatchObject({
      target: { installationId: 'a' },
    });
  });
});

describe('7.5 degraded installations and auth', () => {
  const a = installation({ id: 'a', slug: 'a1', displayName: 'A' });
  const b = installation({ id: 'b', slug: 'b1', displayName: 'B' });

  it('7.5 an installation that fails to list is skipped, not fatal, and reported as degraded', async () => {
    const r = await compileEndpoint(
      base([a, b], { a: new Error('boom'), b: items({ tools: [tool('t')] }) }),
    );
    expect(names(r)).toEqual(['b1__t']);
    expect(r.degraded).toEqual([{ installation: 'a1', code: 'list_failed' }]);
    expect(r.installations.find((i) => i.id === 'a')?.degraded).toBe(true);
  });

  it('7.5 a source-reported degraded result carries its code', async () => {
    const r = await compileEndpoint(
      base([a], { a: { status: 'degraded', code: 'start_timeout' } }),
    );
    expect(r.degraded).toEqual([{ installation: 'a1', code: 'start_timeout' }]);
  });

  it('11.4 installations needing OAuth are served from snapshots and listed in needsAuth', async () => {
    const n = installation({ id: 'n', slug: 'n1', needsAuth: true });
    const r = await compileEndpoint(base([n], { n: items({ tools: [tool('t')] }) }));
    expect(r.needsAuth).toEqual([{ installation: 'n1' }]);
    expect(names(r)).toEqual(['n1__t']);
    const none = await compileEndpoint(base([n], {}));
    expect(none.degraded).toEqual([]);
    expect(none.needsAuth).toEqual([{ installation: 'n1' }]);
  });

  it('7.5 more than 10,000 items from one installation are truncated with a warning', async () => {
    const big = Array.from({ length: 10_001 }, (_, i) => tool(`t${i}`));
    const r = await compileEndpoint(base([a], { a: items({ tools: big }) }));
    expect(r.tools).toHaveLength(10_000);
    expect(r.warnings).toEqual([{ code: 'list_truncated', installation: 'a1', kind: 'tool' }]);
  });

  it('6.7 ttlMs is the minimum upstream ttlMs; the scope is private', async () => {
    const r = await compileEndpoint(
      base([a, b], { a: items({ ttlMs: 9000 }), b: items({ ttlMs: 4000 }) }),
    );
    expect(r).toMatchObject({ ttlMs: 4000, cacheScope: 'private' });
    expect((await compileEndpoint(base([a], { a: items() }))).ttlMs).toBe(60_000);
  });
});

describe('7.6 capabilities, instructions and server info (golden)', () => {
  const a = installation({
    id: 'a',
    slug: 'a1',
    displayName: 'Alpha',
    capabilities: { tools: true, subscribe: true, resources: true },
  });
  const b = installation({
    id: 'b',
    slug: 'b1',
    displayName: 'Beta',
    capabilities: { prompts: true, completions: true },
    layers: { installation: doc({ instructions: { mode: 'append', text: 'Be careful.' } }) },
  });
  const c = installation({
    id: 'c',
    slug: 'c1',
    displayName: 'Gamma',
    capabilities: {},
    layers: { installation: doc({ instructions: { mode: 'replace', text: 'Only this.' } }) },
  });

  it('7.6 declares capabilities when any installation has them; listChanged always; subscribe when supported', async () => {
    const r = await compileEndpoint(base([a, b], { a: items(), b: items() }));
    expect(r.capabilities).toEqual({
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      completions: {},
    });
    const none = await compileEndpoint(base([c], { c: items() }));
    expect(none.capabilities).toEqual({});
    const noSub = await compileEndpoint(
      base([installation({ id: 'x', slug: 'x1', capabilities: { resources: true } })], {
        x: items(),
      }),
    );
    expect(noSub.capabilities).toEqual({ resources: { listChanged: true } });
    const fromItems = await compileEndpoint(
      base([installation({ id: 'y', slug: 'y1', capabilities: {} })], {
        y: items({
          tools: [tool('t')],
          prompts: [{ name: 'p' }],
          resourceTemplates: [{ uriTemplate: 'a://{x}', name: 't' }],
        }),
      }),
    );
    expect(Object.keys(fromItems.capabilities).sort()).toEqual(['prompts', 'resources', 'tools']);
  });

  it('7.6 instructions: endpoint text, then one ## section per installation in endpoint order', async () => {
    const r = await compileEndpoint(
      base(
        [a, b, c],
        {
          a: items({ instructions: 'Use alpha.' }),
          b: items({ instructions: 'Use beta.' }),
          c: items({ instructions: 'ignored' }),
        },
        {
          endpoint: {
            id: 'e',
            kind: 'named',
            prefixMode: 'always',
            installationIds: ['a', 'b', 'c'],
            instructions: 'Hello team.',
          },
        },
      ),
    );
    expect(r.instructions).toBe(
      [
        'Hello team.',
        '## Alpha\nUse alpha.',
        '## Beta\nUse beta.\nBe careful.',
        '## Gamma\nOnly this.',
      ].join('\n\n'),
    );
  });

  it('7.6 no instructions at all leaves the field absent', async () => {
    const r = await compileEndpoint(base([a], { a: items() }));
    expect(r.instructions).toBeUndefined();
    expect('instructions' in r).toBe(false);
  });

  it('7.6 an override-only section still appears for a degraded installation', async () => {
    const r = await compileEndpoint(base([c], {}));
    expect(r.instructions).toBe('## Gamma\nOnly this.');
  });

  it('7.6 instructions are capped at 8,000 characters in endpoint order', async () => {
    const r = await compileEndpoint(
      base([a, b], {
        a: items({ instructions: 'x'.repeat(7950) }),
        b: items({ instructions: 'y'.repeat(500) }),
      }),
    );
    expect(r.instructions).toHaveLength(8000);
    expect(r.instructions?.startsWith('## Alpha\nxxx')).toBe(true);
    expect(r.instructions).toContain('## Beta\nyyy');
    const emoji = await compileEndpoint(
      base([a], { a: items({ instructions: `${'x'.repeat(7990)}${'😀'.repeat(20)}` }) }),
    );
    expect(emoji.instructions?.length).toBeLessThanOrEqual(8000);
    expect(emoji.instructions?.endsWith('\uD83D')).toBe(false);
  });

  it('7.6 serverInfo is { name: "bastion", title: "<org> MCP", version }', async () => {
    const r = await compileEndpoint(base([a], { a: items() }));
    expect(r.serverInfo).toEqual({ name: 'bastion', title: 'Acme MCP', version: '1.2.3' });
  });
});

describe('7.2 purity and providers', () => {
  it('7.2 assembleEndpoint is pure over loaded data and records cache dependencies', () => {
    const a = installation({ id: 'a', slug: 'a1', owner: { kind: 'team', id: 't1', slug: 'eng' } });
    const loaded = [
      { installation: a, listing: { status: 'ok' as const, items: items({ tools: [tool('t')] }) } },
    ];
    const input = base([a], {});
    const r = assembleEndpoint(loaded, input);
    expect(r.tools[0]?.name).toBe('a1__t');
    expect(r.dependencies).toEqual({
      installationIds: ['a'],
      catalogEntryIds: ['e-a'],
      teamIds: ['t1'],
    });
    expect(serializeEndpoint(r)).toBe(serializeEndpoint(assembleEndpoint(loaded, input)));
  });

  it('26 UpstreamProvider lists through the source once and delegates calls to the caller port', async () => {
    const a = installation({ id: 'a', slug: 'a1' });
    let loads = 0;
    const source: UpstreamItemSource = {
      async listItems() {
        loads += 1;
        return {
          status: 'ok',
          items: items({
            tools: [tool('t')],
            prompts: [{ name: 'p' }],
            resources: [{ uri: 'a://b', name: 'b' }],
            resourceTemplates: [{ uriTemplate: 'a://{x}', name: 't' }],
          }),
          origin: 'live',
        };
      },
    };
    const calls: unknown[] = [];
    const p = new UpstreamProvider(a, source, {
      call: async (_i, op) => {
        calls.push(op);
        return { result: 1 };
      },
    });
    const ctx = { principalId: 'u', endpointId: 'e' };
    expect(p.kind).toBe('upstream');
    expect((await p.listTools(ctx)).length).toBe(1);
    expect((await p.listPrompts(ctx)).length).toBe(1);
    expect((await p.listResources(ctx)).length).toBe(1);
    expect((await p.listResourceTemplates(ctx)).length).toBe(1);
    expect(loads).toBe(1);
    expect(await p.call({ method: 'tools/call', name: 't' }, ctx)).toEqual({ result: 1 });
    await expect(
      new UpstreamProvider(a, source).call({ method: 'tools/call' }, ctx),
    ).rejects.toThrow(/UpstreamCaller/);
    const failing = new UpstreamProvider(a, {
      listItems: async () => ({ status: 'degraded', code: 'x' }),
    });
    await expect(failing.listTools(ctx)).rejects.toThrow(/degraded/);
  });

  it('26 the compiler accepts extra (native) providers, with or without listAll', async () => {
    const n = installation({ id: 'n', slug: 'native', displayName: 'Native' });
    const ctxless = {
      kind: 'native' as const,
      installation: n,
      listTools: async () => [tool('hello')],
      listPrompts: async () => [],
      listResources: async () => [],
      listResourceTemplates: async () => [],
      call: async () => ({ result: null }),
    };
    const broken = {
      ...ctxless,
      installation: installation({ id: 'z', slug: 'zz' }),
      listTools: async () => {
        throw new Error('x');
      },
    };
    const r = await compileEndpoint(
      base(
        [],
        {},
        { extraProviders: [ctxless, broken], policy: engineFor([n, broken.installation]) },
      ),
    );
    expect(names(r)).toEqual(['native__hello']);
    expect(r.degraded).toEqual([{ installation: 'zz', code: 'list_failed' }]);
  });
});

describe('12.2 items Bastion hosts itself (added)', () => {
  const layers = {
    catalog: doc({
      added: {
        prompts: { review: { messages: [{ role: 'user', text: 'Review {{repo}}' }] } },
        resources: { 'notes://welcome': { name: 'welcome', text: 'Hello' } },
        resourceTemplates: { 'notes://page/{id}': { name: 'page', text: 'Page {{id}}' } },
      },
    }),
  };
  const inst = installation({ id: 'a', slug: 'alpha', layers });

  it('are listed, routed to be answered by Bastion, and marked as added', async () => {
    const r = await compileEndpoint(base([inst], { a: items({ tools: [tool('search')] }) }));
    expect(r.prompts.map((p) => p.name)).toEqual(['alpha__review']);
    expect(r.promptRoutes.get('alpha__review')?.hosted?.messages[0]?.text).toBe('Review {{repo}}');
    expect(r.resources.map((x) => x.uri)).toEqual(['notes://welcome']);
    expect(r.resourceTemplates.map((x) => x.uriTemplate)).toEqual(['notes://page/{id}']);
    const hosted = resolveResourceUri(r.uriIndex, 'notes://welcome');
    expect(hosted.ok && hosted.target.hosted?.kind).toBe('resource');
    const templated = resolveResourceUri(r.uriIndex, 'notes://page/9');
    expect(templated.ok && templated.target.hosted?.kind).toBe('template');
    expect(r.items.filter((i) => i.added).map((i) => i.kind)).toEqual([
      'prompt',
      'resource',
      'resourceTemplate',
    ]);
    expect(r.capabilities.prompts).toBeDefined();
    expect(r.capabilities.resources).toBeDefined();
  });

  it('can be hidden like any other item, and an upstream item of the same key gives way', async () => {
    const hidden = installation({
      id: 'a',
      slug: 'alpha',
      layers: { ...layers, installation: doc({ prompts: { review: { hidden: true } } }) },
    });
    const r = await compileEndpoint(
      base([hidden], { a: items({ prompts: [{ name: 'review', description: 'upstream' }] }) }),
    );
    expect(r.prompts).toEqual([]);
    const shown = await compileEndpoint(
      base([inst], { a: items({ prompts: [{ name: 'review', description: 'upstream' }] }) }),
    );
    expect(shown.prompts).toHaveLength(1);
    expect(shown.promptRoutes.get('alpha__review')?.hosted).toBeDefined();
  });

  it('are not served while the upstream cannot be listed', async () => {
    const r = await compileEndpoint(base([inst], {}));
    expect(r.prompts).toEqual([]);
    expect(r.degraded).toHaveLength(1);
  });
});

describe('7.3 output schemas a strict client would reject', () => {
  it('7.3 a tool nothing overrides is served without an outputSchema whose type is not "object"', async () => {
    const a = installation({ id: 'a', slug: 'github' });
    const good = { type: 'object', properties: { id: { type: 'string' } } };
    const map = {
      a: items({
        tools: [
          tool('nullable', { outputSchema: { type: ['object', 'null'], properties: {} } }),
          tool('one_of', { outputSchema: { oneOf: [{ type: 'null' }, { type: 'object' }] } }),
          tool('fine', { outputSchema: good }),
        ],
      }),
    };
    const r = await compileEndpoint(base([a], map));
    const byName = new Map(r.tools.map((t) => [t.name, t]));
    expect(byName.get('github__nullable')).not.toHaveProperty('outputSchema');
    expect(byName.get('github__one_of')).not.toHaveProperty('outputSchema');
    expect(byName.get('github__fine')?.outputSchema).toEqual(good);
  });
});
