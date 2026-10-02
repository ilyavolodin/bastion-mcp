/**
 * Glue between catalog entries of kind `skill` and `plugin` (11.1, 25.2) and the plugins package: turning an imported
 * file tree into a draft, and a stored version into a `ReleaseItem` for marketplace releases (25.4).
 *
 * Storage convention: a plugin version keeps its authored files in `catalog_files` plus one synthetic file,
 * `bastion-plugin.json`, holding the authored manifest (name, skills, mcpServers). Manifests that clients read are
 * generated at render time, so this file never appears in a release. A skill version stores the skill directory at
 * the root (`SKILL.md`, ...).
 */
import type { ImportedCatalogDraft } from '@bastion-mcp/api';
import type { PluginFileRow, ReleaseItemSource } from '@bastion-mcp/db';
import {
  decodeUtf8,
  enforceLimits,
  importPluginTree,
  isSemver,
  type PluginFile,
  type PluginManifest,
  PluginValidationError,
  parsePluginManifest,
  parseSkillMd,
  type ReleaseItem,
  standaloneSkillPlugin,
  textFile,
} from '@bastion-mcp/plugins';

export const MANIFEST_FILE = 'bastion-plugin.json';

const kebab = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'plugin';

/** A catalog version label as a semver string for generated manifests (`1` becomes `1.0.0`). */
export const semverOf = (label: string): string => {
  if (isSemver(label)) return label;
  if (/^\d+$/.test(label)) return `${label}.0.0`;
  if (/^\d+\.\d+$/.test(label)) return `${label}.0`;
  return '0.0.0';
};

const b64 = (file: PluginFile): { path: string; contentBase64: string } => ({
  path: file.path,
  contentBase64: Buffer.from(file.content).toString('base64'),
});

/** Classifies a file tree as a skill or a plugin and returns the draft the catalog stores (25.3). */
export const draftFromFiles = (
  files: readonly PluginFile[],
  fallbackName: string,
): ImportedCatalogDraft => {
  enforceLimits([...files]);
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (skillMd) {
    const text = decodeUtf8(skillMd.content);
    if (text === undefined) throw new PluginValidationError('SKILL.md is not valid UTF-8');
    const parsed = parseSkillMd(text);
    return {
      kind: 'skill',
      name: parsed.name,
      description: parsed.description,
      files: files.map(b64),
      warnings: [],
    };
  }
  const paths = new Set(files.map((f) => f.path));
  const looksLikePlugin =
    paths.has('.claude-plugin/plugin.json') ||
    paths.has('plugin.json') ||
    paths.has('.mcp.json') ||
    paths.has('mcp.json') ||
    files.some((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f.path));
  if (!looksLikePlugin) {
    throw new PluginValidationError('the archive holds neither a SKILL.md nor a plugin manifest');
  }
  const { manifest, files: authored } = importPluginTree(files, { name: kebab(fallbackName) });
  const warnings: string[] = [];
  for (const server of manifest.mcpServers) {
    if (server.kind === 'stdio') {
      warnings.push(`stdio server "${server.name}" runs on user machines, not in Bastion`);
    }
  }
  return {
    kind: 'plugin',
    name: manifest.displayName,
    description: manifest.description,
    files: [...authored, textFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`)].map(
      b64,
    ),
    warnings,
  };
};

const readManifestFile = (files: readonly PluginFileRow[]): PluginManifest | undefined => {
  const file = files.find((f) => f.path === MANIFEST_FILE);
  if (!file) return undefined;
  const text = decodeUtf8(file.content);
  if (text === undefined) return undefined;
  try {
    return parsePluginManifest(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** `assemble` of the marketplace store (`MarketplaceStoreDeps`): a stored version to a `ReleaseItem`. */
export const assembleReleaseItem = async (source: ReleaseItemSource): Promise<ReleaseItem> => {
  const { entry, version, policy } = source;
  const label = semverOf(version.label);
  if (entry.kind === 'skill') {
    const text = decodeUtf8(
      source.files.find((f) => f.path === 'SKILL.md')?.content ?? new Uint8Array(),
    );
    const description = text ? parseSkillMd(text).description : entry.displayName;
    const standalone = standaloneSkillPlugin({
      skillName: kebab(entry.slug),
      version: label,
      description: description || entry.displayName,
      displayName: entry.displayName,
      skillFiles: source.files.map((f) => ({ path: f.path, content: f.content, mode: f.mode })),
    });
    return {
      name: standalone.manifest.name,
      version: standalone.manifest.version,
      policy,
      manifest: standalone.manifest,
      files: standalone.files,
      skills: [],
    };
  }
  const stored = readManifestFile(source.files);
  const manifest: PluginManifest = parsePluginManifest({
    ...(stored ?? {
      name: kebab(entry.slug),
      description: entry.displayName,
      displayName: entry.displayName,
      skills: [],
      mcpServers: [],
    }),
    name: kebab(entry.slug),
    version: label !== '0.0.0' || !stored ? label : stored.version,
  });
  const skills: ReleaseItem['skills'] = [];
  for (const component of manifest.skills) {
    if (component.kind !== 'ref') continue;
    const loaded = await source.loadSkillFiles(component.slug, component.version);
    if (!loaded) {
      throw new PluginValidationError('referenced skill does not exist', { slug: component.slug });
    }
    skills.push({
      slug: component.slug,
      name: kebab(loaded.slug),
      files: loaded.files.map((f) => ({ path: f.path, content: f.content, mode: f.mode })),
    });
  }
  return {
    name: manifest.name,
    version: manifest.version,
    policy,
    manifest,
    files: source.files
      .filter((f) => f.path !== MANIFEST_FILE)
      .map((f) => ({ path: f.path, content: f.content, mode: f.mode })),
    skills,
  };
};
