import * as nodeFs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@bastion-mcp/core';
import git from 'isomorphic-git';
import { PluginValidationError } from './errors';
import {
  baseUrl,
  type ItemPolicy,
  jsonBytes,
  type ReleaseItem,
  type RenderContext,
  renderMarketplace,
} from './render';
import { decodeUtf8, type PluginFile } from './types';
import { exportZip } from './zip';

export const BASTION_COMMITTER = {
  name: 'Bastion',
  email: 'noreply@bastion-mcp.github.io',
} as const;

/** What `marketplace_releases` stores (16.2); hashes are lowercase hex. */
export type ReleaseRecord = {
  seq: number;
  /** `[{entryId, versionId, policy}]` is the store's concern; the build needs only these. */
  items: { name: string; version: string; policy: ItemPolicy }[];
  gitCommit: string;
  claudeManifestSha256: string;
  agentsManifestSha256: string;
  archives: Record<string, { version: string; sha256: string }>;
  releaseTime: string;
};

export type BuiltArchive = { plugin: string; version: string; bytes: Uint8Array; sha256: string };

export type BuiltRelease = {
  record: ReleaseRecord;
  /** The repository tree of the release commit. */
  files: PluginFile[];
  claudeManifest: Uint8Array;
  agentsManifest: Uint8Array;
  archives: Map<string, BuiltArchive>;
};

export const archiveFileName = (plugin: string, version: string): string =>
  `${plugin}-${version}.zip`;

export type ReleaseContent = Omit<BuiltRelease, 'record'> & {
  items: ReleaseRecord['items'];
  archiveRecord: ReleaseRecord['archives'];
};

/** Everything of a release except the git commit: files, manifests and archives (25.4). */
export const buildReleaseContent = (
  items: readonly ReleaseItem[],
  ctx: RenderContext,
): ReleaseContent => {
  const rendered = renderMarketplace(items, ctx);
  const archives = new Map<string, BuiltArchive>();
  const archiveRecord: ReleaseRecord['archives'] = {};
  for (const item of items) {
    const plugin = rendered.plugins.get(item.name);
    if (!plugin) continue;
    const bytes = exportZip(plugin.files);
    const sha256 = sha256Hex(bytes);
    archives.set(item.name, { plugin: item.name, version: item.version, bytes, sha256 });
    archiveRecord[item.name] = { version: item.version, sha256 };
  }
  return {
    files: rendered.files,
    claudeManifest: rendered.claudeManifest,
    agentsManifest: rendered.agentsManifest,
    archives,
    items: items.map((i) => ({ name: i.name, version: i.version, policy: i.policy })),
    archiveRecord,
  };
};

type Fs = typeof nodeFs;

/** Writes the tree of `files` into `gitdir` with isomorphic-git and returns the root tree oid. */
const writeTree = async (fs: Fs, gitdir: string, files: readonly PluginFile[]): Promise<string> => {
  type Node = { blobs: { name: string; oid: string; mode: string }[]; dirs: Map<string, Node> };
  const root: Node = { blobs: [], dirs: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop() ?? file.path;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { blobs: [], dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    const oid = await git.writeBlob({ fs, gitdir, blob: file.content });
    node.blobs.push({ name, oid, mode: file.mode === 'executable' ? '100755' : '100644' });
  }
  const write = async (node: Node): Promise<string> => {
    const entries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
    for (const b of node.blobs)
      entries.push({ mode: b.mode, path: b.name, oid: b.oid, type: 'blob' });
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '040000', path: name, oid: await write(child), type: 'tree' });
    }
    return git.writeTree({ fs, gitdir, tree: entries });
  };
  return write(root);
};

/** Creates a bare repository with `main` as the default branch (idempotent). */
export const initBareRepository = async (gitdir: string, fs: Fs = nodeFs): Promise<void> => {
  await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
};

/**
 * Writes the deterministic release commit (25.5): author and committer `Bastion`, timestamp = release
 * time, timezone `+0000`, message `Release <N>`, one parent. Moves `refs/heads/main` and creates
 * `refs/tags/release-<N>`.
 */
export const commitRelease = async (options: {
  gitdir: string;
  files: readonly PluginFile[];
  seq: number;
  releaseTime: Date;
  parentCommit?: string | undefined;
  fs?: Fs;
}): Promise<string> => {
  const fs = options.fs ?? nodeFs;
  const { gitdir } = options;
  const tree = await writeTree(fs, gitdir, options.files);
  const timestamp = Math.floor(options.releaseTime.getTime() / 1000);
  const who = { ...BASTION_COMMITTER, timestamp, timezoneOffset: 0 };
  const oid = await git.writeCommit({
    fs,
    gitdir,
    commit: {
      message: `Release ${options.seq}\n`,
      tree,
      parent: options.parentCommit ? [options.parentCommit] : [],
      author: who,
      committer: who,
    },
  });
  await git.writeRef({ fs, gitdir, ref: 'refs/heads/main', value: oid, force: true });
  await git.writeRef({
    fs,
    gitdir,
    ref: `refs/tags/release-${options.seq}`,
    value: oid,
    force: true,
  });
  return oid;
};

export type BuildReleaseOptions = RenderContext & {
  /** Commit of release `seq - 1`; absent for release 1. */
  parentCommit?: string | undefined;
  /** Bare repository to write into (kept); a temporary one is used and removed when absent. */
  gitdir?: string | undefined;
};

/**
 * Builds release `seq` deterministically (25.4, 25.5, 23.2): the same items, host, sequence, release
 * time and parent give byte-identical files, the same commit SHA, archive digests and manifest
 * digests on every replica and in every process.
 */
export const buildRelease = async (
  items: readonly ReleaseItem[],
  seq: number,
  releaseTime: Date,
  options: BuildReleaseOptions,
): Promise<BuiltRelease> => {
  if (!Number.isInteger(seq) || seq < 1)
    throw new PluginValidationError('release seq must be >= 1');
  const content = buildReleaseContent(items, options);
  const temp = options.gitdir ? undefined : await mkdtemp(join(tmpdir(), 'bastion-release-'));
  const gitdir = options.gitdir ?? join(temp ?? '', 'repo.git');
  try {
    await initBareRepository(gitdir);
    const gitCommit = await commitRelease({
      gitdir,
      files: content.files,
      seq,
      releaseTime,
      parentCommit: options.parentCommit,
    });
    return {
      record: {
        seq,
        items: content.items,
        gitCommit,
        claudeManifestSha256: sha256Hex(content.claudeManifest),
        agentsManifestSha256: sha256Hex(content.agentsManifest),
        archives: content.archiveRecord,
        releaseTime: releaseTime.toISOString(),
      },
      files: content.files,
      claudeManifest: content.claudeManifest,
      agentsManifest: content.agentsManifest,
      archives: content.archives,
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
};

/**
 * The Claude manifest of the HTTPS channel (25.5): the git-form manifest with every plugin source
 * replaced by `{ source: "archive", url, sha256 }` on the same origin.
 */
export const renderHttpsManifest = (
  claudeManifest: Uint8Array,
  release: Pick<ReleaseRecord, 'archives'>,
  options: { host: string; slug: string },
): Uint8Array => {
  const text = decodeUtf8(claudeManifest);
  if (text === undefined) throw new PluginValidationError('manifest is not UTF-8');
  const manifest = JSON.parse(text) as { plugins: { name: string; source: unknown }[] };
  const origin = baseUrl(options.host);
  for (const plugin of manifest.plugins) {
    const archive = release.archives[plugin.name];
    if (!archive)
      throw new PluginValidationError('release has no archive', { plugin: plugin.name });
    plugin.source = {
      source: 'archive',
      url: `${origin}/plugins/${options.slug}/archives/${archiveFileName(plugin.name, archive.version)}`,
      sha256: archive.sha256,
    };
  }
  return jsonBytes(manifest);
};

/** Digest of the HTTPS manifest bytes: the `manifestSha256` pin of 25.7. */
export const httpsManifestSha256 = (
  claudeManifest: Uint8Array,
  release: Pick<ReleaseRecord, 'archives'>,
  options: { host: string; slug: string },
): string => sha256Hex(renderHttpsManifest(claudeManifest, release, options));
