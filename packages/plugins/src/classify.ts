import { canonicalDigest, canonicalJson, sha256Hex } from '@bastion-mcp/core';
import type { PluginManifest } from './manifest';
import { parseSkillMd } from './skill';
import { decodeUtf8, type PluginFile } from './types';

export type FileClassification = 'plain' | 'executable';

export type ClassifiedFile = {
  path: string;
  classification: FileClassification;
  reason: string;
};

/** What the classifier needs of a plugin version: its manifest and its authored file tree. */
export type PluginVersionContent = { manifest: PluginManifest; files: readonly PluginFile[] };

const PLAIN = 'instructions or data';
const BASH_PREAPPROVAL = /(^|[\s,[\]'"])Bash(?![A-Za-z0-9_])/;
const INLINE_INJECTION = /(^|[^\w`])!`[^`\n]+`/;
const FENCED_INJECTION = /^[ \t]*```!/m;

const segments = (path: string): string[] => path.split('/');
const basename = (path: string): string => segments(path).at(-1) ?? path;

const isHookPath = (path: string): boolean => {
  if (basename(path) === 'hooks.json') return true;
  const parts = segments(path);
  const rest = parts[0] === 'claude' || parts[0] === 'openai' ? parts.slice(1) : parts;
  return rest[0] === 'hooks' && rest.length > 1;
};

const preApprovesBash = (value: unknown): boolean => {
  if (typeof value === 'string') return BASH_PREAPPROVAL.test(value);
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && preApprovesBash(v));
  return false;
};

const skillMdReason = (text: string): string | undefined => {
  let body = text;
  try {
    const skill = parseSkillMd(text);
    body = skill.body;
    if (preApprovesBash(skill.frontmatter['allowed-tools'])) {
      return '`allowed-tools` pre-approves Bash';
    }
  } catch {
    if (/allowed-tools[^\n]*\bBash\b/.test(text)) return '`allowed-tools` pre-approves Bash';
  }
  if (INLINE_INJECTION.test(body) || FENCED_INJECTION.test(body)) {
    return 'SKILL.md injects shell command output (!`command`)';
  }
  return undefined;
};

const declaresStdioServer = (text: string): boolean => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof data !== 'object' || data === null) return false;
  const servers = (data as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null) return false;
  return Object.values(servers).some(
    (s) =>
      typeof s === 'object' &&
      s !== null &&
      ('command' in s || (s as { type?: unknown }).type === 'stdio'),
  );
};

/** Classifies one file (25.2). The first matching reason wins. */
export const classifyFile = (file: PluginFile): ClassifiedFile => {
  const executable = (reason: string): ClassifiedFile => ({
    path: file.path,
    classification: 'executable',
    reason,
  });
  if (file.mode === 'executable') return executable('has the exec bit');
  if (file.content[0] === 0x23 && file.content[1] === 0x21) return executable('starts with a shebang');
  if (segments(file.path).includes('scripts')) return executable('lives under scripts/');
  if (isHookPath(file.path)) return executable('hook definition');
  const name = basename(file.path);
  if (name === 'SKILL.md' || name === '.mcp.json' || name === 'mcp.json') {
    const text = decodeUtf8(file.content);
    if (text !== undefined) {
      if (name === 'SKILL.md') {
        const reason = skillMdReason(text);
        if (reason) return executable(reason);
      } else if (declaresStdioServer(text)) {
        return executable('declares a local (stdio) MCP server');
      }
    }
  }
  return { path: file.path, classification: 'plain', reason: PLAIN };
};

export const classifyFiles = (files: readonly PluginFile[]): ClassifiedFile[] =>
  files.map(classifyFile);

/** Manifest components that run code locally, as pseudo-paths `plugin.json#...`. */
export const classifyManifest = (manifest: PluginManifest): (ClassifiedFile & { digest: string })[] => {
  const out: (ClassifiedFile & { digest: string })[] = [];
  for (const server of manifest.mcpServers) {
    if (server.kind === 'stdio') {
      out.push({
        path: `plugin.json#mcpServers/${server.name}`,
        classification: 'executable',
        reason: 'local (stdio) MCP server',
        digest: sha256Hex(canonicalJson(server)),
      });
    }
  }
  const hooks = manifest.claude?.pluginJson?.hooks;
  if (hooks !== undefined) {
    out.push({
      path: 'plugin.json#claude.hooks',
      classification: 'executable',
      reason: 'hook definition',
      digest: sha256Hex(canonicalJson(hooks)),
    });
  }
  return out;
};

/** The list shown to the approver (25.3): every file plus executable manifest components. */
export const classifyVersion = (version: PluginVersionContent): ClassifiedFile[] => [
  ...classifyFiles(version.files),
  ...classifyManifest(version.manifest).map(({ digest: _digest, ...rest }) => rest),
];

/** Managers publish plain plugins; any executable content needs an Admin approval (10.1, 25.2). */
export const requiresAdminApproval = (version: PluginVersionContent): boolean =>
  classifyVersion(version).some((c) => c.classification === 'executable');

export type ExecutableEntry = { path: string; sha256: string; mode: string };

export const executableEntries = (version: PluginVersionContent): ExecutableEntry[] => {
  const byPath = new Map(version.files.map((f) => [f.path, f]));
  const entries: ExecutableEntry[] = [];
  for (const c of classifyFiles(version.files)) {
    const file = byPath.get(c.path);
    if (c.classification === 'executable' && file) {
      entries.push({ path: c.path, sha256: sha256Hex(file.content), mode: file.mode });
    }
  }
  for (const m of classifyManifest(version.manifest)) {
    entries.push({ path: m.path, sha256: m.digest, mode: 'file' });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

export type ExecutableDiffEntry = {
  path: string;
  change: 'added' | 'modified' | 'removed';
  before: string | null;
  after: string | null;
};

/** Canonical diff of the executable content against the previously approved version (25.2). */
export const reviewedDiff = (
  previouslyApproved: PluginVersionContent | undefined,
  current: PluginVersionContent,
): ExecutableDiffEntry[] => {
  const before = new Map(
    (previouslyApproved ? executableEntries(previouslyApproved) : []).map((e) => [e.path, e]),
  );
  const after = new Map(executableEntries(current).map((e) => [e.path, e]));
  const out: ExecutableDiffEntry[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b && a) {
      if (b.sha256 !== a.sha256 || b.mode !== a.mode) {
        out.push({ path, change: 'modified', before: b.sha256, after: a.sha256 });
      }
    } else if (a) out.push({ path, change: 'added', before: null, after: a.sha256 });
    else if (b) out.push({ path, change: 'removed', before: b.sha256, after: null });
  }
  return out;
};

/** `reviewed_diff_sha256` (16.2), hex. Binds an approval to the exact executable content. */
export const reviewedDiffSha256 = (
  previouslyApproved: PluginVersionContent | undefined,
  current: PluginVersionContent,
): string => canonicalDigest(reviewedDiff(previouslyApproved, current)).toString('hex');

export type ApprovalStatus = 'not-required' | 'pending' | 'approved' | 'stale';

/**
 * Publish gate (10.1): plain versions pass; executable ones need an approval whose reviewed digest
 * matches the diff against the previously approved version.
 */
export const approvalStatus = (
  current: PluginVersionContent,
  previouslyApproved: PluginVersionContent | undefined,
  approval: { reviewedDiffSha256: string } | undefined,
): ApprovalStatus => {
  if (!requiresAdminApproval(current)) return 'not-required';
  if (!approval) return 'pending';
  return approval.reviewedDiffSha256 === reviewedDiffSha256(previouslyApproved, current)
    ? 'approved'
    : 'stale';
};
