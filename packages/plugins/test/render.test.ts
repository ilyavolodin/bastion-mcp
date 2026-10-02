import { describe, expect, it } from 'vitest';
import {
  classificationStep,
  decodeUtf8,
  mapPolicy,
  parsePluginManifest,
  PluginValidationError,
  renderMarketplace,
  renderPlugin,
  textFile,
  validateAgentPluginsRendering,
} from '../src';
import {
  expectGolden,
  marketplaceInfo,
  plainItem,
  reviewItem,
  sampleItems,
  toolboxItem,
} from './helpers/fixtures';

const ctx = { host: 'mcp.example.com', marketplace: marketplaceInfo };
const text = (bytes: Uint8Array): string => decodeUtf8(bytes) ?? '';

describe('25.4 generated repository layout', () => {
  const render = renderMarketplace(sampleItems(), ctx);
  const paths = render.files.map((f) => f.path);

  it('25.4 emits exactly the layout of the spec', () => {
    expect(paths).toEqual([
      '.agents/plugins/marketplace.json',
      '.claude-plugin/marketplace.json',
      'plugins/code-review/.claude-plugin/plugin.json',
      'plugins/code-review/.mcp.json',
      'plugins/code-review/apps.json',
      'plugins/code-review/commands/review.md',
      'plugins/code-review/mcp.json',
      'plugins/code-review/plugin.json',
      'plugins/code-review/skills/review/SKILL.md',
      'plugins/code-review/skills/review/references/checklist.md',
      'plugins/code-review/skills/style-guide/SKILL.md',
      'plugins/code-review/skills/style-guide/assets/rules.txt',
      'plugins/notes/.claude-plugin/plugin.json',
      'plugins/notes/plugin.json',
      'plugins/notes/skills/notes/SKILL.md',
      'plugins/toolbox/.claude-plugin/plugin.json',
      'plugins/toolbox/.mcp.json',
      'plugins/toolbox/mcp.json',
      'plugins/toolbox/plugin.json',
      'plugins/toolbox/skills/lint/SKILL.md',
      'plugins/toolbox/skills/lint/scripts/run.sh',
    ]);
  });

  it('25.4 golden: Claude marketplace manifest', () => {
    expectGolden('claude-marketplace.json', text(render.claudeManifest));
  });

  it('25.4 golden: Agent Plugins marketplace manifest', () => {
    expectGolden('agents-marketplace.json', text(render.agentsManifest));
  });

  it('25.4 golden: Claude plugin.json for every policy', () => {
    for (const p of ['code-review', 'toolbox', 'notes']) {
      const file = render.files.find((f) => f.path === `plugins/${p}/.claude-plugin/plugin.json`);
      expectGolden(`plugins/${p}/claude-plugin.json`, text(file?.content ?? new Uint8Array()));
    }
  });

  it('25.4 golden: Agent Plugins plugin.json for every plugin', () => {
    for (const p of ['code-review', 'toolbox', 'notes']) {
      const file = render.files.find((f) => f.path === `plugins/${p}/plugin.json`);
      expectGolden(`plugins/${p}/plugin.json`, text(file?.content ?? new Uint8Array()));
    }
  });

  it('25.4 golden: .mcp.json and mcp.json', () => {
    for (const [p, f] of [
      ['code-review', '.mcp.json'],
      ['code-review', 'mcp.json'],
      ['toolbox', '.mcp.json'],
      ['toolbox', 'mcp.json'],
    ] as const) {
      const file = render.files.find((x) => x.path === `plugins/${p}/${f}`);
      expectGolden(`plugins/${p}/${f.replace('.mcp', 'dot-mcp')}`, text(file?.content ?? new Uint8Array()));
    }
  });

  it('25.4 Bastion MCP references use the exact JSON shapes of the spec', () => {
    const claude = render.files.find((f) => f.path === 'plugins/code-review/.mcp.json');
    const agents = render.files.find((f) => f.path === 'plugins/code-review/mcp.json');
    expect(JSON.parse(text(claude?.content ?? new Uint8Array())).mcpServers.github).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp/c/github',
      oauth: true,
    });
    const a = JSON.parse(text(agents?.content ?? new Uint8Array()));
    expect(a.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    expect(a.mcpServers.github).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp/c/github',
    });
  });

  it('25.4 the manifest mapping table', () => {
    expect(mapPolicy('available')).toEqual({ agentsInstallation: 'AVAILABLE' });
    expect(mapPolicy('installedByDefault')).toEqual({
      claudeInstallationPreference: 'auto_install',
      agentsInstallation: 'INSTALLED_BY_DEFAULT',
    });
    expect(mapPolicy('required')).toEqual({
      claudeInstallationPreference: 'required',
      agentsInstallation: 'INSTALLED_BY_DEFAULT',
    });
    const agents = JSON.parse(text(render.agentsManifest));
    const byName = Object.fromEntries(agents.plugins.map((p: { name: string }) => [p.name, p]));
    expect(byName['code-review'].policy).toEqual({
      installation: 'INSTALLED_BY_DEFAULT',
      authentication: 'ON_FIRST_USE',
    });
    expect(byName.notes.policy).toEqual({ installation: 'AVAILABLE' });
    expect(byName.notes.source).toEqual({ source: 'local', path: './plugins/notes' });
    const claude = JSON.parse(text(render.claudeManifest));
    expect(claude.name).toBe('acme-tools');
    expect(claude.plugins[0]).toEqual({
      name: 'code-review',
      source: './plugins/code-review',
      description: 'Review code',
    });
    const pj = (name: string) =>
      JSON.parse(text(render.files.find((f) => f.path === `plugins/${name}/.claude-plugin/plugin.json`)?.content ?? new Uint8Array()));
    expect(pj('code-review').installationPreference).toBe('auto_install');
    expect(pj('toolbox').installationPreference).toBe('required');
    expect(pj('notes').installationPreference).toBeUndefined();
  });

  it('25.4 emits Claude-only parts only into Claude files and OpenAI-only parts only into Agent Plugins files', () => {
    const rendered = renderPlugin(reviewItem(), 'mcp.example.com');
    const claude = rendered.claudeFiles.map((f) => f.path);
    const agents = rendered.agentsFiles.map((f) => f.path);
    expect(claude).toContain('commands/review.md');
    expect(claude).toContain('.claude-plugin/plugin.json');
    expect(claude).not.toContain('plugin.json');
    expect(claude).not.toContain('mcp.json');
    expect(claude).not.toContain('apps.json');
    expect(agents).toContain('apps.json');
    expect(agents).toContain('plugin.json');
    expect(agents).not.toContain('commands/review.md');
    expect(agents).not.toContain('.mcp.json');
  });

  it('25.2 extensions.com.openai fields land only in the Agent Plugins plugin.json', () => {
    const rendered = renderPlugin(reviewItem(), 'mcp.example.com');
    const agents = JSON.parse(text(rendered.files.find((f) => f.path === 'plugin.json')?.content ?? new Uint8Array()));
    expect(agents.extensions).toEqual({ 'com.openai': { category: 'Engineering' } });
    expect(agents.apps).toBe('./apps.json');
    const claude = JSON.parse(text(rendered.files.find((f) => f.path === '.claude-plugin/plugin.json')?.content ?? new Uint8Array()));
    expect(claude.extensions).toBeUndefined();
    expect(claude.author).toEqual({ name: 'Acme' });
  });

  it('25.4 rejects collisions between authored files and generated manifests', () => {
    const bad = { ...plainItem(), files: [...plainItem().files, textFile('plugin.json', '{}')] };
    expect(() => renderPlugin(bad, 'h')).toThrow(PluginValidationError);
    const dup = {
      ...plainItem(),
      files: [...plainItem().files, textFile('claude/hooks/hooks.json', '{}'), textFile('openai/hooks/hooks.json', '{}')],
    };
    expect(() => renderPlugin(dup, 'h')).toThrow(/twice/);
  });

  it('25.4 rejects unresolved skill references, empty inline skills and duplicate plugin names', () => {
    const unresolved = { ...reviewItem(), skills: [] };
    expect(() => renderPlugin(unresolved, 'h')).toThrow(/not resolved/);
    const emptyInline = { ...plainItem(), files: [] };
    expect(() => renderPlugin(emptyInline, 'h')).toThrow(/no files/);
    expect(() => renderMarketplace([plainItem(), plainItem()], ctx)).toThrow(/duplicate/);
    const renamed = { ...plainItem(), name: 'other' };
    expect(() => renderMarketplace([renamed], ctx)).toThrow(/inconsistent/);
  });

  it('25.4 accepts a host with a scheme and trailing slash', () => {
    const r = renderPlugin(reviewItem(), 'https://mcp.example.com/');
    const mcp = r.files.find((f) => f.path === '.mcp.json');
    expect(text(mcp?.content ?? new Uint8Array())).toContain('"https://mcp.example.com/mcp/c/github"');
  });

  it('25.4 a manifest with an empty marketplace still renders both manifests', () => {
    const empty = renderMarketplace([], ctx);
    expect(empty.files.map((f) => f.path)).toEqual(['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']);
    expect(JSON.parse(text(empty.claudeManifest)).plugins).toEqual([]);
  });

  it('25.4 author-supplied JSON keys are sorted so output does not depend on key order', () => {
    const a = { ...toolboxItem(), manifest: parsePluginManifest({ ...toolboxItem().manifest, claude: { pluginJson: { b: 1, a: { y: 1, x: 2 } } } }) };
    const b = { ...toolboxItem(), manifest: parsePluginManifest({ ...toolboxItem().manifest, claude: { pluginJson: { a: { x: 2, y: 1 }, b: 1 } } }) };
    const pa = renderPlugin(a, 'h').files.find((f) => f.path === '.claude-plugin/plugin.json');
    const pb = renderPlugin(b, 'h').files.find((f) => f.path === '.claude-plugin/plugin.json');
    expect(text(pa?.content ?? new Uint8Array())).toBe(text(pb?.content ?? new Uint8Array()));
  });
});

describe('25.3 Agent Plugins schema validation (vendored schemas)', () => {
  it('25.3 accepts the generated Agent Plugins rendering of every sample plugin', () => {
    for (const item of sampleItems()) {
      const rendered = renderPlugin(item, 'mcp.example.com');
      const result = validateAgentPluginsRendering(rendered.agentsFiles);
      expect(result.findings, item.name).toEqual([]);
      expect(result.status).toBe('passed');
    }
  });

  it('25.3 reports schema violations of plugin.json and mcp.json', () => {
    const bad = validateAgentPluginsRendering([
      textFile('plugin.json', JSON.stringify({ name: 'Bad Name', version: '1', extra: true })),
      textFile('mcp.json', JSON.stringify({ mcpServers: { a: { type: 'streamable-http' } } })),
    ]);
    expect(bad.status).toBe('failed');
    expect(bad.findings.length).toBeGreaterThanOrEqual(4);
    expect(bad.findings.some((f) => f.path === 'mcp.json')).toBe(true);
    expect(validateAgentPluginsRendering([]).findings[0]?.message).toMatch(/missing/);
    expect(validateAgentPluginsRendering([textFile('plugin.json', '{oops')]).findings[0]?.message).toMatch(/JSON/);
  });

  it('25.3 classification step lists executable files for the approver', () => {
    const step = classificationStep(renderPlugin(toolboxItem(), 'h').files);
    expect(step.status).toBe('passed');
    expect(step.summary).toMatch(/executable/);
    expect(step.findings.map((f) => f.path)).toContain('skills/lint/scripts/run.sh');
    expect(classificationStep([textFile('a.md', 'a')]).summary).toMatch(/plain/);
  });
});
