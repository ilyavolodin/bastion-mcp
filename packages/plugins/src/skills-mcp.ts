import { type ReleaseItem, renderPlugin } from './render';
import { parseSkillMd } from './skill';
import { decodeUtf8 } from './types';

/** MCP Skills extension id and its capability object, declared on every endpoint (25.8). */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILLS_CAPABILITY = { directoryRead: true } as const;

/** A plugin from a marketplace the caller can see, at the release the caller is served. */
export type VisiblePlugin = { marketplace: string; item: ReleaseItem };

export type SkillContent =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

export type IndexedSkill = {
  plugin: string;
  skill: string;
  name: string;
  description: string;
  uri: string;
  marketplace: string;
  files: { path: string; content: Uint8Array }[];
};

export type SkillIndex = ReadonlyMap<string, IndexedSkill>;

const skillUri = (plugin: string, skill: string, path = 'SKILL.md'): string =>
  `skill://${plugin}/${skill}/${path}`;

/** Indexes the Bastion-hosted skills of the caller's visible marketplaces (25.8). First plugin wins. */
export const buildSkillIndex = (plugins: readonly VisiblePlugin[], host: string): SkillIndex => {
  const index = new Map<string, IndexedSkill>();
  for (const { marketplace, item } of plugins) {
    const rendered = renderPlugin(item, host);
    const bySkill = new Map<string, { path: string; content: Uint8Array }[]>();
    for (const file of rendered.files) {
      const match = /^skills\/([^/]+)\/(.+)$/.exec(file.path);
      if (!match?.[1] || !match[2]) continue;
      const list = bySkill.get(match[1]) ?? [];
      list.push({ path: match[2], content: file.content });
      bySkill.set(match[1], list);
    }
    for (const [skill, files] of bySkill) {
      const key = `${item.name}/${skill}`;
      const skillMd = files.find((f) => f.path === 'SKILL.md');
      const text = skillMd ? decodeUtf8(skillMd.content) : undefined;
      if (index.has(key) || text === undefined) continue;
      try {
        const parsed = parseSkillMd(text);
        index.set(key, {
          plugin: item.name,
          skill,
          name: parsed.name,
          description: parsed.description,
          uri: skillUri(item.name, skill),
          marketplace,
          files,
        });
      } catch {
        // A skill with unreadable frontmatter is not advertised.
      }
    }
  }
  return index;
};

/** `skills/list` result. */
export const listSkills = (
  index: SkillIndex,
): { skills: { name: string; description: string; uri: string; plugin: string }[] } => ({
  skills: [...index.values()]
    .sort((a, b) => (a.uri < b.uri ? -1 : 1))
    .map((s) => ({ name: s.name, description: s.description, uri: s.uri, plugin: s.plugin })),
});

const mimeFor = (path: string, text: string | undefined): string => {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'application/yaml';
  return text !== undefined ? 'text/plain' : 'application/octet-stream';
};

const toContent = (uri: string, path: string, bytes: Uint8Array): SkillContent => {
  const text = decodeUtf8(bytes);
  const mimeType = mimeFor(path, text);
  return text !== undefined
    ? { uri, mimeType, text }
    : { uri, mimeType, blob: Buffer.from(bytes).toString('base64') };
};

/** `skills/get` for `{ uri }` or `{ plugin, name }`: the skill with every file. */
export const getSkill = (
  index: SkillIndex,
  ref: { uri: string } | { plugin: string; name: string },
):
  | { name: string; description: string; uri: string; plugin: string; files: SkillContent[] }
  | undefined => {
  let skill: IndexedSkill | undefined;
  if ('uri' in ref) {
    const parsed = parseSkillUri(ref.uri);
    skill = parsed ? index.get(`${parsed.plugin}/${parsed.skill}`) : undefined;
  } else {
    skill = [...index.values()].find((s) => s.plugin === ref.plugin && s.name === ref.name);
  }
  if (!skill) return undefined;
  const { plugin, skill: dir } = skill;
  return {
    name: skill.name,
    description: skill.description,
    uri: skill.uri,
    plugin,
    files: [...skill.files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => toContent(skillUri(plugin, dir, f.path), f.path, f.content)),
  };
};

export const parseSkillUri = (
  uri: string,
): { plugin: string; skill: string; path: string } | undefined => {
  const match = /^skill:\/\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\/(.*))?$/.exec(uri);
  if (!match?.[1] || !match[2]) return undefined;
  const path = match[3] ?? '';
  if (path.split('/').some((s) => s === '..' || s === '.')) return undefined;
  return { plugin: match[1], skill: match[2], path };
};

/**
 * `resources/read` for `skill://<plugin>/<skill>/...`. A directory URI (`directoryRead`) returns every
 * file under it; a file URI returns that file. `undefined` when it is not visible to the caller.
 */
export const readSkillResource = (
  index: SkillIndex,
  uri: string,
): { contents: SkillContent[] } | undefined => {
  const parsed = parseSkillUri(uri);
  if (!parsed) return undefined;
  const skill = index.get(`${parsed.plugin}/${parsed.skill}`);
  if (!skill) return undefined;
  const prefix = parsed.path.replace(/\/+$/, '');
  const exact = skill.files.find((f) => f.path === prefix);
  if (exact) return { contents: [toContent(uri, exact.path, exact.content)] };
  const below = skill.files
    .filter((f) => prefix === '' || f.path.startsWith(`${prefix}/`))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (below.length === 0) return undefined;
  return {
    contents: below.map((f) =>
      toContent(skillUri(parsed.plugin, skill.skill, f.path), f.path, f.content),
    ),
  };
};

export type CatalogInstallation = { id: string; state: string };

export type CatalogRouteResolution =
  | { action: 'existing'; installation: CatalogInstallation; source: 'own' | 'team' }
  | { action: 'create'; origin: 'plugin'; scope: 'user' }
  | { action: 'needs-setup'; origin: 'plugin'; scope: 'user'; state: 'needs_setup' }
  | { action: 'not-visible' };

/**
 * `/mcp/c/{catalogSlug}` resolution (25.8): the caller's own installation first, then a team one.
 * Without either, a visible entry gets a user installation created on the first request
 * (`origin = plugin`), starting in `needs_setup` when the entry requires setup.
 */
export const resolveCatalogRoute = (input: {
  ownInstallation?: CatalogInstallation | undefined;
  teamInstallation?: CatalogInstallation | undefined;
  visible: boolean;
  needsSetup: boolean;
}): CatalogRouteResolution => {
  if (input.ownInstallation) {
    return { action: 'existing', installation: input.ownInstallation, source: 'own' };
  }
  if (input.teamInstallation) {
    return { action: 'existing', installation: input.teamInstallation, source: 'team' };
  }
  if (!input.visible) return { action: 'not-visible' };
  return input.needsSetup
    ? { action: 'needs-setup', origin: 'plugin', scope: 'user', state: 'needs_setup' }
    : { action: 'create', origin: 'plugin', scope: 'user' };
};
