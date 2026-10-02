import type { MARKETPLACE_ITEM_POLICIES } from '@bastion-mcp/core';
import { PluginValidationError } from './errors';
import { mcpServerKey, type McpServerComponent, type PluginManifest } from './manifest';
import { encodeText, type PluginFile, sortFiles } from './types';

export type ItemPolicy = (typeof MARKETPLACE_ITEM_POLICIES)[number];

export const AGENT_PLUGINS_SCHEMA_BASE = 'https://agent-plugins.org/schemas/1.0.0';
export const AGENT_PLUGIN_SCHEMA_URL = `${AGENT_PLUGINS_SCHEMA_BASE}/plugin.schema.json`;
export const AGENT_MCP_SCHEMA_URL = `${AGENT_PLUGINS_SCHEMA_BASE}/mcp.schema.json`;

/** A referenced catalog skill, resolved by the caller (pinned version or current). */
export type ResolvedSkill = {
  slug: string;
  name: string;
  /** Paths relative to the skill directory. */
  files: PluginFile[];
};

/** A plugin version resolved for a release: authored tree plus resolved skill references. */
export type ReleaseItem = {
  /** Plugin name (= manifest.name). */
  name: string;
  version: string;
  policy: ItemPolicy;
  manifest: PluginManifest;
  /** Authored files: `skills/<s>/...` inline, `claude/...` Claude-only, `openai/...` OpenAI-only. */
  files: PluginFile[];
  skills: ResolvedSkill[];
};

export type MarketplaceInfo = {
  slug: string;
  displayName: string;
  description?: string | undefined;
  ownerName: string;
};

export type RenderContext = { host: string; marketplace: MarketplaceInfo };

export const baseUrl = (host: string): string =>
  /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;

/** Recursively sorts object keys; arrays keep their order. Used for author-supplied JSON. */
export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
};

/** Pretty JSON with a trailing newline: the single serialization of every generated manifest. */
export const jsonBytes = (value: unknown): Uint8Array => encodeText(`${JSON.stringify(value, null, 2)}\n`);

/** The manifest mapping table of 25.4. */
export const mapPolicy = (
  policy: ItemPolicy,
): { claudeInstallationPreference?: 'auto_install' | 'required'; agentsInstallation: string } => {
  switch (policy) {
    case 'available':
      return { agentsInstallation: 'AVAILABLE' };
    case 'installedByDefault':
      return { claudeInstallationPreference: 'auto_install', agentsInstallation: 'INSTALLED_BY_DEFAULT' };
    case 'required':
      return { claudeInstallationPreference: 'required', agentsInstallation: 'INSTALLED_BY_DEFAULT' };
  }
};

const mcpUrl = (host: string, slug: string): string => `${baseUrl(host)}/mcp/c/${slug}`;

const claudeServer = (server: McpServerComponent, host: string): Record<string, unknown> => {
  switch (server.kind) {
    case 'bastion':
      return { type: 'http', url: mcpUrl(host, server.slug), oauth: true };
    case 'remote':
      return { type: 'http', url: server.url };
    case 'stdio':
      return {
        command: server.command,
        ...(server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(server.env).length > 0 ? { env: sortKeys(server.env) } : {}),
      };
  }
};

const agentsServer = (server: McpServerComponent, host: string): Record<string, unknown> => {
  switch (server.kind) {
    case 'bastion':
      return { type: 'streamable-http', url: mcpUrl(host, server.slug) };
    case 'remote':
      return { type: 'streamable-http', url: server.url };
    case 'stdio':
      return {
        type: 'stdio',
        command: server.command,
        ...(server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(server.env).length > 0 ? { env: sortKeys(server.env) } : {}),
      };
  }
};

/** `.mcp.json` of a plugin (Claude); `undefined` when the plugin declares no MCP servers. */
export const renderClaudeMcp = (manifest: PluginManifest, host: string): unknown => {
  if (manifest.mcpServers.length === 0) return undefined;
  return {
    mcpServers: Object.fromEntries(
      manifest.mcpServers.map((s) => [mcpServerKey(s), claudeServer(s, host)]),
    ),
  };
};

/** `mcp.json` of a plugin (Agent Plugins 1.0). */
export const renderAgentsMcp = (manifest: PluginManifest, host: string): unknown => {
  if (manifest.mcpServers.length === 0) return undefined;
  return {
    $schema: AGENT_MCP_SCHEMA_URL,
    mcpServers: Object.fromEntries(
      manifest.mcpServers.map((s) => [mcpServerKey(s), agentsServer(s, host)]),
    ),
  };
};

const RESERVED_PLUGIN_ROOT = new Set([
  '.claude-plugin/plugin.json',
  'plugin.json',
  '.mcp.json',
  'mcp.json',
]);
const CLAUDE_RESERVED_KEYS = new Set(['name', 'version', 'description', 'installationPreference']);

/** Maps an authored path to its place in the plugin root and the client it is emitted for. */
const placeAuthored = (path: string): { path: string; only: 'claude' | 'openai' | 'both' } => {
  if (path.startsWith('claude/')) return { path: path.slice('claude/'.length), only: 'claude' };
  if (path.startsWith('openai/')) return { path: path.slice('openai/'.length), only: 'openai' };
  return { path, only: 'both' };
};

export type RenderedPlugin = {
  /** Every file of `plugins/<name>/`, paths relative to the plugin root, sorted. */
  files: PluginFile[];
  /** Files of the Claude rendering only (for `claude plugin validate`). */
  claudeFiles: PluginFile[];
  /** Files of the Agent Plugins rendering only (for JSON Schema validation). */
  agentsFiles: PluginFile[];
};

/** Renders one plugin into the generated layout of 25.4. */
export const renderPlugin = (item: ReleaseItem, host: string): RenderedPlugin => {
  const { manifest } = item;
  const out = new Map<string, PluginFile>();
  const claudeOnly = new Set<string>();
  const agentsOnly = new Set<string>();
  const put = (file: PluginFile, only: 'claude' | 'openai' | 'both' = 'both'): void => {
    if (out.has(file.path)) {
      throw new PluginValidationError('path produced twice while rendering', {
        plugin: manifest.name,
        path: file.path,
      });
    }
    out.set(file.path, file);
    if (only === 'claude') claudeOnly.add(file.path);
    if (only === 'openai') agentsOnly.add(file.path);
  };

  for (const file of item.files) {
    if (RESERVED_PLUGIN_ROOT.has(file.path)) {
      throw new PluginValidationError('authored file collides with a generated manifest', {
        plugin: manifest.name,
        path: file.path,
      });
    }
    const placed = placeAuthored(file.path);
    put({ ...file, path: placed.path }, placed.only);
  }

  for (const component of manifest.skills) {
    if (component.kind === 'inline') {
      if (!item.files.some((f) => f.path.startsWith(`${component.path}/`))) {
        throw new PluginValidationError('inline skill has no files', {
          plugin: manifest.name,
          path: component.path,
        });
      }
      continue;
    }
    const resolved = item.skills.find((s) => s.slug === component.slug);
    if (!resolved) {
      throw new PluginValidationError('referenced skill was not resolved', {
        plugin: manifest.name,
        slug: component.slug,
      });
    }
    for (const file of resolved.files) {
      put({ ...file, path: `skills/${resolved.name}/${file.path}` });
    }
  }
  const hasSkills = [...out.keys()].some((p) => p.startsWith('skills/'));

  const claudeJson: Record<string, unknown> = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  };
  const preference = mapPolicy(item.policy).claudeInstallationPreference;
  if (preference) claudeJson.installationPreference = preference;
  for (const [k, v] of Object.entries(
    sortKeys(manifest.claude?.pluginJson ?? {}) as Record<string, unknown>,
  )) {
    if (!CLAUDE_RESERVED_KEYS.has(k)) claudeJson[k] = v;
  }
  put({ path: '.claude-plugin/plugin.json', content: jsonBytes(claudeJson), mode: 'file' }, 'claude');

  const agentsJson: Record<string, unknown> = {
    $schema: AGENT_PLUGIN_SCHEMA_URL,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    displayName: manifest.displayName,
  };
  if (hasSkills) agentsJson.skills = './skills/';
  if (manifest.mcpServers.length > 0) agentsJson.mcpServers = './mcp.json';
  if (out.has('apps.json')) agentsJson.apps = './apps.json';
  if (out.has('hooks/hooks.json') && !claudeOnly.has('hooks/hooks.json')) {
    agentsJson.hooks = './hooks/hooks.json';
  }
  if (manifest.openai?.extensions) {
    agentsJson.extensions = { 'com.openai': sortKeys(manifest.openai.extensions) };
  }
  put({ path: 'plugin.json', content: jsonBytes(agentsJson), mode: 'file' }, 'openai');

  const claudeMcp = renderClaudeMcp(manifest, host);
  if (claudeMcp !== undefined) put({ path: '.mcp.json', content: jsonBytes(claudeMcp), mode: 'file' }, 'claude');
  const agentsMcp = renderAgentsMcp(manifest, host);
  if (agentsMcp !== undefined) put({ path: 'mcp.json', content: jsonBytes(agentsMcp), mode: 'file' }, 'openai');

  const all = sortFiles([...out.values()]);
  return {
    files: all,
    claudeFiles: all.filter((f) => !agentsOnly.has(f.path)),
    agentsFiles: all.filter((f) => !claudeOnly.has(f.path)),
  };
};

/** `.claude-plugin/marketplace.json` for the git channel (25.4). */
export const renderClaudeMarketplace = (
  marketplace: MarketplaceInfo,
  items: readonly ReleaseItem[],
): Uint8Array =>
  jsonBytes({
    name: marketplace.slug,
    owner: { name: marketplace.ownerName },
    ...(marketplace.description ? { metadata: { description: marketplace.description } } : {}),
    plugins: items.map((i) => ({
      name: i.name,
      source: `./plugins/${i.name}`,
      description: i.manifest.description,
    })),
  });

/** `.agents/plugins/marketplace.json` (25.4). */
export const renderAgentsMarketplace = (
  marketplace: MarketplaceInfo,
  items: readonly ReleaseItem[],
): Uint8Array =>
  jsonBytes({
    name: marketplace.slug,
    interface: { displayName: marketplace.displayName },
    plugins: items.map((i) => ({
      name: i.name,
      source: { source: 'local', path: `./plugins/${i.name}` },
      policy: {
        installation: mapPolicy(i.policy).agentsInstallation,
        ...(i.manifest.mcpServers.length > 0 ? { authentication: 'ON_FIRST_USE' } : {}),
      },
    })),
  });

export type MarketplaceRender = {
  /** The whole generated repository, sorted by path. */
  files: PluginFile[];
  claudeManifest: Uint8Array;
  agentsManifest: Uint8Array;
  plugins: Map<string, RenderedPlugin>;
};

/** The generated repository layout of 25.4 for resolved release items. */
export const renderMarketplace = (
  items: readonly ReleaseItem[],
  ctx: RenderContext,
): MarketplaceRender => {
  const names = new Set<string>();
  const plugins = new Map<string, RenderedPlugin>();
  const files: PluginFile[] = [];
  for (const item of items) {
    if (names.has(item.name) || item.name !== item.manifest.name) {
      throw new PluginValidationError('duplicate or inconsistent plugin name', { name: item.name });
    }
    names.add(item.name);
    const rendered = renderPlugin(item, ctx.host);
    plugins.set(item.name, rendered);
    for (const f of rendered.files) files.push({ ...f, path: `plugins/${item.name}/${f.path}` });
  }
  const claudeManifest = renderClaudeMarketplace(ctx.marketplace, items);
  const agentsManifest = renderAgentsMarketplace(ctx.marketplace, items);
  files.push({ path: '.claude-plugin/marketplace.json', content: claudeManifest, mode: 'file' });
  files.push({ path: '.agents/plugins/marketplace.json', content: agentsManifest, mode: 'file' });
  return { files: sortFiles(files), claudeManifest, agentsManifest, plugins };
};
