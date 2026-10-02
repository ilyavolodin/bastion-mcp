import { z } from 'zod';
import { PluginValidationError } from './errors';
import {
  isSemver,
  type McpServerComponent,
  type PluginManifest,
  parsePluginManifest,
} from './manifest';
import { decodeUtf8, type PluginFile } from './types';

const CLAUDE_ONLY_ROOTS = ['commands', 'agents', 'hooks', 'output-styles'];
const OPENAI_ONLY_FILES = ['apps.json'];

const looseManifest = z.looseObject({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  displayName: z.string().optional(),
});

const mcpFile = z.object({ mcpServers: z.record(z.string(), z.looseObject({})) });

const readJson = (files: readonly PluginFile[], path: string): unknown => {
  const file = files.find((f) => f.path === path);
  if (!file) return undefined;
  const text = decodeUtf8(file.content);
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    throw new PluginValidationError(`${path} is not valid JSON`);
  }
};

const serversFrom = (data: unknown): McpServerComponent[] => {
  const parsed = mcpFile.safeParse(data);
  if (!parsed.success) return [];
  const out: McpServerComponent[] = [];
  for (const [name, server] of Object.entries(parsed.data.mcpServers)) {
    const url = (server as { url?: unknown }).url;
    const command = (server as { command?: unknown }).command;
    if (typeof url === 'string') out.push({ kind: 'remote', name, url });
    else if (typeof command === 'string') {
      const args = (server as { args?: unknown }).args;
      const env = (server as { env?: unknown }).env;
      out.push({
        kind: 'stdio',
        name,
        command,
        args: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [],
        env: z.record(z.string(), z.string()).catch({}).parse(env),
      });
    }
  }
  return out;
};

/**
 * Converts an imported plugin directory (Claude or Agent Plugins layout) into Bastion's authored
 * form (25.2, 25.3): a manifest plus a file tree where Claude-only parts live under `claude/` and
 * OpenAI-only parts under `openai/`. Manifests and MCP files are regenerated at render time.
 */
export const importPluginTree = (
  files: readonly PluginFile[],
  fallback: { name?: string; version?: string } = {},
): { manifest: PluginManifest; files: PluginFile[] } => {
  const raw =
    readJson(files, '.claude-plugin/plugin.json') ?? readJson(files, 'plugin.json') ?? undefined;
  const meta = looseManifest.safeParse(
    raw ?? (fallback.name ? { name: fallback.name } : undefined),
  );
  if (!meta.success) throw new PluginValidationError('plugin manifest with a name is required');
  const version = meta.data.version ?? fallback.version ?? '0.0.0';
  if (!isSemver(version)) {
    throw new PluginValidationError('plugin versions must be semver', { version });
  }
  const skillDirs = new Set<string>();
  const authored: PluginFile[] = [];
  for (const file of files) {
    if (
      file.path === '.claude-plugin/plugin.json' ||
      file.path === 'plugin.json' ||
      file.path === '.mcp.json' ||
      file.path === 'mcp.json'
    ) {
      continue;
    }
    const [root, second] = file.path.split('/');
    if (root === 'skills' && second && file.path.split('/').length > 2) skillDirs.add(second);
    if (root !== undefined && CLAUDE_ONLY_ROOTS.includes(root) && file.path.includes('/')) {
      authored.push({ ...file, path: `claude/${file.path}` });
    } else if (OPENAI_ONLY_FILES.includes(file.path)) {
      authored.push({ ...file, path: `openai/${file.path}` });
    } else authored.push(file);
  }
  const servers = [
    ...serversFrom(readJson(files, '.mcp.json')),
    ...serversFrom(readJson(files, 'mcp.json')),
  ];
  const unique = [
    ...new Map(servers.map((s) => [s.kind === 'bastion' ? s.slug : s.name, s])).values(),
  ];
  const manifest = parsePluginManifest({
    name: meta.data.name,
    version,
    description: meta.data.description ?? meta.data.name,
    displayName: meta.data.displayName ?? meta.data.name,
    skills: [...skillDirs].sort().map((d) => ({ kind: 'inline', path: `skills/${d}` })),
    mcpServers: unique,
  });
  return { manifest, files: authored };
};
