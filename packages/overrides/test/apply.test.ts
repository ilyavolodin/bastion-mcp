import { describe, expect, it } from 'vitest';
import {
  applyInstructions,
  applyText,
  applyToPrompt,
  applyToResource,
  applyToResourceTemplate,
  applyToTool,
} from '../src/apply';
import { emptyOverrides, type OverridesDocument } from '../src/schema';
import type {
  FinalPrompt,
  FinalResource,
  FinalResourceTemplate,
  FinalTool,
  UpstreamTool,
} from '../src/types';

const doc = (partial: Partial<OverridesDocument>): OverridesDocument => ({
  ...emptyOverrides(),
  ...partial,
});

const createIssue = (): UpstreamTool => ({
  name: 'create_issue',
  title: 'Create issue',
  description: 'Creates an issue.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', 'x-mcp-header': 'Owner' },
      repo: { type: 'string', enum: ['web', 'api', 'infra', 'docs'] },
      title: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['owner', 'repo', 'title'],
  },
  annotations: { readOnlyHint: false, title: 'x' },
  _meta: {
    'io.modelcontextprotocol/related-task': { taskId: '1' },
    ui: { resourceUri: 'ui://a' },
    'internal/debug': true,
  },
});

const tool = (
  override: OverridesDocument['tools'][string],
  upstream = createIssue(),
): FinalTool => {
  const result = applyToTool(upstream, {
    installation: doc({ tools: { [upstream.name]: override } }),
  });
  if (result.kind !== 'tool') throw new Error(`expected tool, got ${result.kind}`);
  return result;
};

const props = (t: FinalTool): Record<string, unknown> =>
  (t.tool.inputSchema.properties ?? {}) as Record<string, unknown>;

describe('12.3 applyToTool', () => {
  it('12.3 without overrides the tool is unchanged and call plan is inert', () => {
    const result = applyToTool(createIssue(), {});
    expect(result.kind === 'tool' && result.tool).toEqual(createIssue());
    expect(result.kind === 'tool' && result.plan.validate).toBe(false);
  });

  it('12.3 hidden removes the item', () => {
    expect(
      applyToTool(createIssue(), {
        installation: doc({ tools: { 'create_*': { hidden: true } } }),
      }),
    ).toEqual({
      kind: 'hidden',
    });
  });

  it('12.3 hidden set in the catalog layer is hidden unless the installation sets hidden false', () => {
    const catalog = doc({ tools: { create_issue: { hidden: true } } });
    expect(applyToTool(createIssue(), { catalog }).kind).toBe('hidden');
    expect(
      applyToTool(createIssue(), {
        catalog,
        installation: doc({ tools: { create_issue: { hidden: false } } }),
      }).kind,
    ).toBe('tool');
  });

  it('12.3 name sets the exact final name and is reported for the router (suppresses prefixing)', () => {
    const r = tool({ name: 'gh_new_issue' });
    expect(r.tool.name).toBe('gh_new_issue');
    expect(r.exactName).toBe('gh_new_issue');
    expect(r.upstreamName).toBe('create_issue');
    expect(r.plan.upstreamName).toBe('create_issue');
    expect(applyToTool(createIssue(), {})).toMatchObject({ upstreamName: 'create_issue' });
    expect(tool({ title: 'x' }).exactName).toBeUndefined();
  });

  it('12.3 title replaces', () => {
    expect(tool({ title: 'New' }).tool.title).toBe('New');
  });

  it('12.3 description replaces by default and supports append, prepend and replace modes', () => {
    expect(tool({ description: 'Only this' }).tool.description).toBe('Only this');
    expect(tool({ description: { mode: 'append', text: 'More.' } }).tool.description).toBe(
      'Creates an issue.\nMore.',
    );
    expect(tool({ description: { mode: 'prepend', text: 'First.' } }).tool.description).toBe(
      'First.\nCreates an issue.',
    );
    expect(tool({ description: { mode: 'replace', text: 'R' } }).tool.description).toBe('R');
  });

  it('12.3 append and prepend on a missing description yield the text', () => {
    expect(applyText(undefined, { mode: 'append', text: 'a' })).toBe('a');
    expect(applyText('', { mode: 'prepend', text: 'a' })).toBe('a');
  });

  it('12.3 pinned arguments are removed from properties and required', () => {
    const r = tool({ pinnedArguments: { owner: 'acme' } });
    expect(Object.keys(props(r))).toEqual(['repo', 'title', 'labels']);
    expect(r.tool.inputSchema.required).toEqual(['repo', 'title']);
    expect(r.plan.pinned).toEqual({ owner: 'acme' });
    expect(r.plan.validate).toBe(true);
  });

  it('12.3 pinning every required argument drops the required keyword', () => {
    const r = tool({ pinnedArguments: { owner: 'a', repo: 'web', title: 't' } });
    expect(r.tool.inputSchema.required).toBeUndefined();
  });

  it('12.3 pinned values may use value templates and are validated at apply time', () => {
    expect(tool({ pinnedArguments: { owner: '{{user.email}}' } }).plan.pinned).toEqual({
      owner: '{{user.email}}',
    });
    const bad = applyToTool(createIssue(), {
      installation: doc({ tools: { create_issue: { pinnedArguments: { owner: '{{nope.x}}' } } } }),
    });
    expect(bad).toMatchObject({ kind: 'invalid', degraded: true });
  });

  it('12.3 does not modify the upstream definition', () => {
    const upstream = createIssue();
    tool({ pinnedArguments: { owner: 'a' }, title: 'x' }, upstream);
    expect(upstream).toEqual(createIssue());
  });

  it('12.3 defaultArguments sets default in the schema', () => {
    const r = tool({ defaultArguments: { labels: ['from-mcp'] } });
    expect(props(r).labels).toMatchObject({ default: ['from-mcp'] });
    expect(r.plan.defaults).toEqual({ labels: ['from-mcp'] });
    expect(r.plan.validate).toBe(false);
  });

  it('12.3 defaults for unknown properties are ignored with an issue; pinned arguments win over defaults', () => {
    const r = tool({
      defaultArguments: { nope: 1, owner: 'x' },
      pinnedArguments: { owner: 'acme' },
    });
    expect(r.plan.defaults).toEqual({});
    expect(r.issues.map((i) => i.code)).toEqual([
      'x_mcp_header_dropped',
      'default_for_unknown_property',
    ]);
  });

  it('12.3 inputSchemaPatch is applied after pinning', () => {
    const r = tool({
      pinnedArguments: { owner: 'acme' },
      inputSchemaPatch: [
        { op: 'replace', path: '/properties/repo/enum', value: ['web', 'api', 'infra'] },
      ],
    });
    expect(props(r).repo).toMatchObject({ enum: ['web', 'api', 'infra'] });
    expect(r.invalid).toBeUndefined();
    expect(r.plan.validate).toBe(true);
  });

  it('12.3 a patch cannot re-add a pinned property', () => {
    const r = tool({
      pinnedArguments: { owner: 'acme' },
      inputSchemaPatch: [
        { op: 'add', path: '/properties/owner', value: { type: 'string' } },
        { op: 'add', path: '/required/-', value: 'owner' },
      ],
    });
    expect(props(r).owner).toBeUndefined();
    expect(r.tool.inputSchema.required).not.toContain('owner');
    expect(r.issues.map((i) => i.code)).toContain('patch_readded_pinned_property');
  });

  it('12.3 a patch that does not apply marks the override invalid and serves the item without the patch', () => {
    const r = tool({
      title: 'Kept',
      inputSchemaPatch: [{ op: 'remove', path: '/properties/nope/enum' }],
    });
    expect(r.invalid?.field).toBe('inputSchemaPatch');
    expect(r.invalid?.error).toMatch(/./);
    expect(r.tool.inputSchema).toEqual(createIssue().inputSchema);
    expect(r.tool.title).toBe('Kept');
    expect(r.plan.validate).toBe(false);
  });

  it('12.3 a patch whose result is not valid JSON Schema 2020-12 is invalid, not thrown', () => {
    const r = tool({
      inputSchemaPatch: [{ op: 'replace', path: '/properties/repo/type', value: 'not-a-type' }],
    });
    expect(r.invalid?.error).toMatch(/./);
    expect(r.tool.inputSchema).toEqual(createIssue().inputSchema);
  });

  it('12.3 a failing test op marks the patch invalid', () => {
    const r = tool({ inputSchemaPatch: [{ op: 'test', path: '/type', value: 'array' }] });
    expect(r.invalid).toBeDefined();
  });

  it('12.3 annotations merge into the upstream annotations', () => {
    const r = tool({ annotations: { destructiveHint: false, title: 'y' } });
    expect(r.tool.annotations).toEqual({ readOnlyHint: false, title: 'y', destructiveHint: false });
  });

  it('12.3 annotations are created when upstream has none', () => {
    const upstream = createIssue();
    delete upstream.annotations;
    expect(tool({ annotations: { idempotentHint: true } }, upstream).tool.annotations).toEqual({
      idempotentHint: true,
    });
  });

  it('12.3 meta set and remove edit _meta', () => {
    const r = tool({ meta: { set: { 'acme/tag': 'x' }, remove: ['internal/debug'] } });
    expect(r.tool._meta).toEqual({
      'io.modelcontextprotocol/related-task': { taskId: '1' },
      ui: { resourceUri: 'ui://a' },
      'acme/tag': 'x',
    });
  });

  it('12.3 keys under io.modelcontextprotocol/ cannot be removed and the reason is reported', () => {
    const r = tool({ meta: { remove: ['io.modelcontextprotocol/related-task'] } });
    expect(r.tool._meta).toHaveProperty(['io.modelcontextprotocol/related-task']);
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: 'meta_remove_forbidden',
        message: expect.stringContaining('io.modelcontextprotocol/'),
      }),
    ]);
  });

  it('6.8 MCP Apps _meta.ui passes through: it cannot be removed or overwritten', () => {
    const r = tool({ meta: { remove: ['ui'], set: { ui: { csp: 'x' } } } });
    expect(r.tool._meta?.ui).toEqual({ resourceUri: 'ui://a' });
    expect(r.issues.map((i) => i.code).sort()).toEqual([
      'meta_remove_forbidden',
      'meta_set_forbidden',
    ]);
  });

  it('12.3 removing the last _meta key removes _meta', () => {
    const upstream = { ...createIssue(), _meta: { a: 1 } };
    expect(tool({ meta: { remove: ['a'] } }, upstream).tool._meta).toBeUndefined();
  });

  it('12.3 timeoutMs, guardProfileId and outputTransform are carried in the plan', () => {
    const r = tool({ timeoutMs: 5, guardProfileId: null, outputTransform: { maxTextBytes: 9 } });
    expect(r.plan).toMatchObject({
      timeoutMs: 5,
      guardProfileId: null,
      outputTransform: { maxTextBytes: 9 },
    });
  });

  it('12.3 glob and exact entries fold: exact applies last, installation over catalog', () => {
    const catalog = doc({ tools: { '*': { title: 'all', description: 'cat' } } });
    const installation = doc({
      tools: { 'create_*': { title: 'glob' }, create_issue: { description: 'inst' } },
    });
    const r = applyToTool(createIssue(), { catalog, installation });
    expect(r.kind === 'tool' && r.tool.title).toBe('glob');
    expect(r.kind === 'tool' && r.tool.description).toBe('inst');
  });

  it('12.3 a tool without inputSchema object still gets a schema', () => {
    const upstream = { name: 'x', inputSchema: undefined } as unknown as UpstreamTool;
    const r = applyToTool(upstream, {});
    expect(r.kind === 'tool' && r.tool.inputSchema).toEqual({ type: 'object' });
  });
});

describe('12.3 x-mcp-header validation after overrides (2026-07-28)', () => {
  const withHeader = (extra: Record<string, unknown>): UpstreamTool => ({
    name: 't',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string', 'x-mcp-header': 'Region' }, ...extra },
    },
  });
  const run = (u: UpstreamTool, override: OverridesDocument['tools'][string] = {}) =>
    applyToTool(u, { installation: doc({ tools: { t: override } }) });

  it('12.3 annotations on pinned properties are dropped (reported) and the tool is served', () => {
    const r = run(withHeader({}), { pinnedArguments: { a: 'eu' } });
    expect(r.kind).toBe('tool');
    expect(r.kind === 'tool' && r.issues[0]?.code).toBe('x_mcp_header_dropped');
  });

  it('12.3 a valid annotation is kept', () => {
    const r = run(withHeader({}));
    expect(r.kind === 'tool' && props(r).a).toMatchObject({ 'x-mcp-header': 'Region' });
  });

  it.each([
    ['empty name', { b: { type: 'string', 'x-mcp-header': '' } }],
    ['space in name', { b: { type: 'string', 'x-mcp-header': 'Bad Name' } }],
    ['colon in name', { b: { type: 'string', 'x-mcp-header': 'Bad:Name' } }],
    ['non string name', { b: { type: 'string', 'x-mcp-header': 5 } }],
    ['non-ASCII name', { b: { type: 'string', 'x-mcp-header': 'Région' } }],
    ['case-insensitive duplicate', { b: { type: 'string', 'x-mcp-header': 'region' } }],
    ['object type', { b: { type: 'object', 'x-mcp-header': 'Other' } }],
    ['array type', { b: { type: 'array', 'x-mcp-header': 'Other' } }],
    ['no type', { b: { 'x-mcp-header': 'Other' } }],
  ])('12.3 invalid x-mcp-header (%s) withholds the tool as degraded with an error', (_n, extra) => {
    const r = run(withHeader(extra));
    expect(r).toMatchObject({ kind: 'invalid', degraded: true });
    expect(r.kind === 'invalid' && r.error).toMatch(/x-mcp-header/);
  });

  it('12.3 enum or const of primitives and type unions count as primitive', () => {
    expect(run(withHeader({ b: { enum: ['x', 'y'], 'x-mcp-header': 'B' } })).kind).toBe('tool');
    expect(run(withHeader({ c: { const: 3, 'x-mcp-header': 'C' } })).kind).toBe('tool');
    expect(run(withHeader({ d: { type: ['string', 'integer'], 'x-mcp-header': 'D' } })).kind).toBe(
      'tool',
    );
  });

  it('12.3 a patch that introduces an invalid annotation withholds the tool', () => {
    const r = run(withHeader({}), {
      inputSchemaPatch: [{ op: 'add', path: '/properties/a/x-mcp-header', value: 'Bad Name' }],
    });
    expect(r.kind).toBe('invalid');
  });
});

describe('12.3 prompts', () => {
  const upstream = {
    name: 'review_pr',
    description: 'Review',
    arguments: [
      { name: 'style', required: false },
      { name: 'pr', required: true },
      { name: 'verbose', required: false },
    ],
  };
  const run = (override: OverridesDocument['prompts'][string]): FinalPrompt => {
    const r = applyToPrompt(upstream, { installation: doc({ prompts: { review_pr: override } }) });
    if (r.kind !== 'prompt') throw new Error('expected prompt');
    return r;
  };

  it('12.3 pinned arguments are removed from the advertised list and recorded', () => {
    const r = run({ arguments: { style: { pinned: 'acme' } } });
    expect(r.prompt.arguments?.map((a) => a.name)).toEqual(['pr', 'verbose']);
    expect(r.plan.pinned).toEqual({ style: 'acme' });
  });

  it('12.3 hidden hides an argument when it is not required', () => {
    const r = run({ arguments: { verbose: { hidden: true } } });
    expect(r.prompt.arguments?.map((a) => a.name)).toEqual(['style', 'pr']);
    expect(r.plan.hidden).toEqual(['verbose']);
  });

  it('12.3 a required argument cannot be hidden', () => {
    const r = run({ arguments: { pr: { hidden: true } } });
    expect(r.prompt.arguments?.map((a) => a.name)).toContain('pr');
    expect(r.plan.hidden).toEqual([]);
    expect(r.issues[0]?.code).toBe('hidden_required_argument');
  });

  it('12.3 name, title and description apply; messagesTransform is kept in the plan', () => {
    const messagesTransform = {
      prepend: [{ role: 'user' as const, content: { type: 'text', text: 'hi' } }],
    };
    const r = run({
      name: 'pr_review',
      title: 'T',
      description: 'Review against checklist',
      messagesTransform,
    });
    expect(r.prompt).toMatchObject({
      name: 'pr_review',
      title: 'T',
      description: 'Review against checklist',
    });
    expect(r.exactName).toBe('pr_review');
    expect(r.plan.messagesTransform).toEqual(messagesTransform);
  });

  it('12.3 hidden prompts are removed', () => {
    expect(
      applyToPrompt(upstream, { installation: doc({ prompts: { 'review_*': { hidden: true } } }) }),
    ).toEqual({ kind: 'hidden' });
  });

  it('12.3 invalid pinned value templates withhold the prompt', () => {
    const r = applyToPrompt(upstream, {
      installation: doc({
        prompts: { review_pr: { arguments: { style: { pinned: '{{bad.x}}' } } } },
      }),
    });
    expect(r.kind).toBe('invalid');
  });

  it('12.3 prompts without arguments are handled', () => {
    const r = applyToPrompt(
      { name: 'p' },
      { installation: doc({ prompts: { p: { arguments: { a: { pinned: 'x' } } } } }) },
    );
    expect(r.kind).toBe('prompt');
  });
});

describe('12.3 resources and resource templates', () => {
  const resource = { uri: 'file:///a.txt', name: 'a', description: 'A' };
  const template = { uriTemplate: 'repo://{owner}/{repo}/contents/{path}', name: 'contents' };
  const opts = { installationSlug: 'github' };

  it('12.3 hidden resources are removed (glob keys)', () => {
    const layers = { installation: doc({ resources: { 'file:///a*': { hidden: true } } }) };
    expect(applyToResource(resource, layers, opts)).toEqual({ kind: 'hidden' });
  });

  it('12.3 title and description apply to resources', () => {
    const layers = {
      installation: doc({
        resources: {
          'file:///a.txt': { title: 'T', description: { mode: 'append', text: 'more' } },
        },
      }),
    };
    const r = applyToResource(resource, layers, opts) as FinalResource;
    expect(r.resource).toMatchObject({ title: 'T', description: 'A\nmore', uri: 'file:///a.txt' });
    expect(r.route).toEqual({ kind: 'resource' });
  });

  it('12.3 uriPrefix true rewrites URIs as bastion+{slug}:{original}', () => {
    const r = applyToResource(
      resource,
      { installation: doc({ uriPrefix: true }) },
      opts,
    ) as FinalResource;
    expect(r.resource.uri).toBe('bastion+github:file:///a.txt');
    expect(r.upstreamUri).toBe('file:///a.txt');
    expect(r.route).toEqual({ kind: 'resource', prefixSlug: 'github' });
  });

  it('12.3 uriPrefix from the catalog layer applies and the installation can turn it off', () => {
    const catalog = doc({ uriPrefix: true });
    expect((applyToResource(resource, { catalog }, opts) as FinalResource).resource.uri).toMatch(
      /^bastion\+/,
    );
    expect(
      (
        applyToResource(
          resource,
          { catalog, installation: doc({ uriPrefix: false }) },
          opts,
        ) as FinalResource
      ).resource.uri,
    ).toBe(resource.uri);
  });

  it('12.3 pinnedVariables substitute into the advertised template', () => {
    const layers = {
      installation: doc({
        resourceTemplates: { [template.uriTemplate]: { pinnedVariables: { owner: 'acme' } } },
      }),
    };
    const r = applyToResourceTemplate(template, layers, opts) as FinalResourceTemplate;
    expect(r.template.uriTemplate).toBe('repo://acme/{repo}/contents/{path}');
    expect(r.upstreamTemplate).toBe(template.uriTemplate);
    expect(r.route).toEqual({
      kind: 'template',
      upstreamTemplate: template.uriTemplate,
      pinnedVariables: { owner: 'acme' },
    });
  });

  it('12.3 pinnedVariables may use value templates resolved with the template context', () => {
    const layers = {
      installation: doc({
        resourceTemplates: {
          [template.uriTemplate]: { pinnedVariables: { owner: '{{var.org}}' } },
        },
      }),
    };
    const ok = applyToResourceTemplate(template, layers, {
      ...opts,
      templateContext: { var: { org: 'acme' } },
    }) as FinalResourceTemplate;
    expect(ok.template.uriTemplate).toBe('repo://acme/{repo}/contents/{path}');
    expect(applyToResourceTemplate(template, layers, opts).kind).toBe('invalid');
  });

  it('12.3 a pinned variable that cannot be substituted withholds the template', () => {
    const t = { uriTemplate: 'x://{?a,b}', name: 'q' };
    const layers = {
      installation: doc({ resourceTemplates: { 'x://{?a,b}': { pinnedVariables: { a: '1' } } } }),
    };
    expect(applyToResourceTemplate(t, layers, opts).kind).toBe('invalid');
  });

  it('7.4 templates are prefixed with uriPrefix, and hide/title/description apply', () => {
    const layers = {
      installation: doc({
        uriPrefix: true,
        resourceTemplates: { [template.uriTemplate]: { title: 'T', description: 'D' } },
      }),
    };
    const r = applyToResourceTemplate(template, layers, opts) as FinalResourceTemplate;
    expect(r.template).toMatchObject({
      uriTemplate: 'bastion+github:repo://{owner}/{repo}/contents/{path}',
      title: 'T',
      description: 'D',
    });
    expect(r.route).toMatchObject({ prefixSlug: 'github' });
    const hidden = {
      installation: doc({ resourceTemplates: { [template.uriTemplate]: { hidden: true } } }),
    };
    expect(applyToResourceTemplate(template, hidden, opts)).toEqual({ kind: 'hidden' });
  });
});

describe('12.3 instructions', () => {
  it('12.3 append adds to the upstream instructions', () => {
    const layers = { installation: doc({ instructions: { mode: 'append', text: 'Use acme.' } }) };
    expect(applyInstructions('Be nice.', layers)).toBe('Be nice.\nUse acme.');
  });

  it('12.3 replace replaces the upstream instructions', () => {
    const layers = { installation: doc({ instructions: { mode: 'replace', text: 'Only this.' } }) };
    expect(applyInstructions('Be nice.', layers)).toBe('Only this.');
  });

  it('12.3 append without upstream instructions yields the text; no override passes through', () => {
    const layers = { catalog: doc({ instructions: { mode: 'append', text: 'x' } }) };
    expect(applyInstructions(undefined, layers)).toBe('x');
    expect(applyInstructions('keep', {})).toBe('keep');
    expect(applyInstructions(undefined, {})).toBeUndefined();
  });
});
