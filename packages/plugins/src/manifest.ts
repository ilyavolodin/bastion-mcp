import { z } from 'zod';
import { PluginValidationError } from './errors';
import type { PluginFile } from './types';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isSemver = (value: string): boolean => SEMVER.test(value);

const kebab = z.string().max(64).regex(KEBAB, 'must be kebab-case');

/** A `skills` component: a reference to a catalog skill (pinned or following current) or inline. */
const skillComponent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ref'),
    /** Catalog slug of the skill entry. */
    slug: z.string().min(1),
    /** Pinned version label; absent means follow current. */
    version: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('inline'),
    /** Directory inside the plugin tree, `skills/<skill>`. */
    path: z.string().regex(/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
]);

/** An `mcpServers` component (25.2). */
const mcpServerComponent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bastion'), slug: z.string().min(1) }),
  z.object({
    kind: z.literal('remote'),
    name: kebab,
    url: z.url({ protocol: /^https?$/ }),
  }),
  z.object({
    kind: z.literal('stdio'),
    name: kebab,
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
]);

export const pluginManifestSchema = z.object({
  name: kebab,
  version: z.string().refine(isSemver, 'plugin versions must be semver'),
  description: z.string().min(1).max(1024),
  displayName: z.string().min(1).max(120),
  skills: z.array(skillComponent).default([]),
  mcpServers: z.array(mcpServerComponent).default([]),
  /** Claude-only: `commands/`, `agents/`, `hooks/hooks.json`, `output-styles/` live under `claude/`. */
  claude: z.object({ pluginJson: z.record(z.string(), z.unknown()).optional() }).optional(),
  /** OpenAI-only: `apps.json`, `hooks/hooks.json` live under `openai/`; `extensions` -> `com.openai`. */
  openai: z.object({ extensions: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type McpServerComponent = PluginManifest['mcpServers'][number];
export type SkillComponent = PluginManifest['skills'][number];

export const mcpServerKey = (server: McpServerComponent): string =>
  server.kind === 'bastion' ? server.slug : server.name;

/** Parses an untrusted manifest. Non-semver versions are rejected for plugins (25.2). */
export const parsePluginManifest = (input: unknown): PluginManifest => {
  const parsed = pluginManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginValidationError('invalid plugin manifest', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const names = new Set<string>();
  for (const server of parsed.data.mcpServers) {
    const key = mcpServerKey(server);
    if (names.has(key)) throw new PluginValidationError('duplicate MCP server name', { name: key });
    names.add(key);
  }
  return parsed.data;
};

/** A standalone skill added to a marketplace is published as a plugin of the same name (25.2). */
export const standaloneSkillPlugin = (input: {
  skillName: string;
  version: string;
  description: string;
  displayName?: string;
  /** Skill files, paths relative to the skill directory. */
  skillFiles: readonly PluginFile[];
}): { manifest: PluginManifest; files: PluginFile[] } => {
  const manifest = parsePluginManifest({
    name: input.skillName,
    version: input.version,
    description: input.description,
    displayName: input.displayName ?? input.skillName,
    skills: [{ kind: 'inline', path: `skills/${input.skillName}` }],
  });
  const files = input.skillFiles.map((f) => ({
    ...f,
    path: `skills/${input.skillName}/${f.path}`,
  }));
  return { manifest, files };
};
