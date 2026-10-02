import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import git, { type HttpClient } from 'isomorphic-git';
import { z } from 'zod';
import { PluginValidationError } from './errors';
import { enforceLimits, normalizePath, type PluginLimits } from './paths';
import { decodeUtf8, type PluginFile, sortFiles } from './types';

/** Looser caps for a whole repository (a marketplace holds many plugins); each plugin is re-checked. */
export const REPO_LIMITS: PluginLimits = {
  maxUnpackedBytes: 200 * 1024 * 1024,
  maxFiles: 20_000,
  maxFileBytes: 5 * 1024 * 1024,
};

export type GitFs = typeof nodeFs;

export type GitTree = { commit: string; files: PluginFile[] };

/**
 * Reads the tree at `ref` (branch, tag or commit SHA) from a local git directory. Symlinks and
 * submodules are rejected (25.2).
 */
export const readGitTree = async (options: {
  gitdir: string;
  ref: string;
  fs?: GitFs;
  limits?: PluginLimits;
}): Promise<GitTree> => {
  const fs = options.fs ?? nodeFs;
  const limits = options.limits ?? REPO_LIMITS;
  const { gitdir } = options;
  let commit: string;
  try {
    commit = await git.resolveRef({ fs, gitdir, ref: options.ref });
  } catch {
    try {
      commit = await git.expandOid({ fs, gitdir, oid: options.ref });
    } catch {
      throw new PluginValidationError('git ref not found', { ref: options.ref });
    }
  }
  const files: PluginFile[] = [];
  let total = 0;
  await git.walk({
    fs,
    gitdir,
    trees: [git.TREE({ ref: commit })],
    map: async (filepath, [entry]) => {
      if (filepath === '.' || !entry) return undefined;
      const type = await entry.type();
      if (type === 'tree') return undefined;
      const mode = await entry.mode();
      if (type !== 'blob' || mode === 0o120000 || mode === 0o160000) {
        throw new PluginValidationError('symlinks and submodules are rejected', {
          path: filepath,
        });
      }
      const content = await entry.content();
      if (!content) return undefined;
      total += content.byteLength;
      if (files.length + 1 > limits.maxFiles || total > limits.maxUnpackedBytes) {
        throw new PluginValidationError('repository exceeds the import limits');
      }
      files.push({
        path: normalizePath(filepath),
        content,
        mode: (mode & 0o111) !== 0 ? 'executable' : 'file',
      });
      return undefined;
    },
  });
  enforceLimits(files, limits);
  return { commit, files: sortFiles(files) };
};

/**
 * Imports a repository over HTTPS at a ref (25.3): a shallow bare clone into a temporary directory,
 * read, then removed. `http` and credentials are injected, so tests stay offline.
 */
export const importFromGit = async (options: {
  url: string;
  ref: string;
  http?: HttpClient;
  fs?: GitFs;
  username?: string;
  password?: string;
  limits?: PluginLimits;
  signal?: AbortSignal;
}): Promise<GitTree> => {
  const fs = options.fs ?? nodeFs;
  const http = options.http ?? (await import('isomorphic-git/http/node')).default;
  const dir = await mkdtemp(join(tmpdir(), 'bastion-import-'));
  try {
    const credentials = options.password
      ? { username: options.username ?? 'x-access-token', password: options.password }
      : undefined;
    await git.clone({
      fs,
      http,
      dir,
      gitdir: join(dir, 'repo.git'),
      url: options.url,
      ref: options.ref,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
      noTags: true,
      ...(credentials ? { onAuth: () => credentials } : {}),
    });
    return await readGitTree({
      gitdir: join(dir, 'repo.git'),
      ref: 'HEAD',
      fs,
      ...(options.limits ? { limits: options.limits } : {}),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export type DiscoveredItem = {
  kind: 'plugin' | 'skill';
  /** Directory of the item inside the repository; `''` is the root. */
  dir: string;
  name?: string;
  /** Marketplace entries whose source is not inside the repository (not importable here). */
  external?: boolean;
};

const claudeMarketplace = z.object({
  plugins: z.array(
    z.object({ name: z.string(), source: z.union([z.string(), z.looseObject({})]) }),
  ),
});
const agentsMarketplace = z.object({
  plugins: z.array(
    z.object({
      name: z.string(),
      source: z.union([
        z.string(),
        z.looseObject({ source: z.string().optional(), path: z.string().optional() }),
      ]),
    }),
  ),
});

const cleanDir = (value: string): string => value.replace(/^\.\//, '').replace(/\/+$/, '');

const parseJsonFile = (files: readonly PluginFile[], path: string): unknown => {
  const file = files.find((f) => f.path === path);
  if (!file) return undefined;
  const text = decodeUtf8(file.content);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new PluginValidationError(`${path} is not valid JSON`);
  }
};

/** Finds the plugins and skills of a repository tree: marketplace manifests, a root plugin or skill. */
export const discoverItems = (files: readonly PluginFile[]): DiscoveredItem[] => {
  const items: DiscoveredItem[] = [];
  const seen = new Set<string>();
  const add = (item: DiscoveredItem): void => {
    const key = `${item.kind}:${item.dir}:${item.name ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  };
  const claude = claudeMarketplace.safeParse(parseJsonFile(files, '.claude-plugin/marketplace.json'));
  if (claude.success) {
    for (const p of claude.data.plugins) {
      if (typeof p.source === 'string') add({ kind: 'plugin', dir: cleanDir(p.source), name: p.name });
      else add({ kind: 'plugin', dir: '', name: p.name, external: true });
    }
  }
  const agents = agentsMarketplace.safeParse(
    parseJsonFile(files, '.agents/plugins/marketplace.json'),
  );
  if (agents.success) {
    for (const p of agents.data.plugins) {
      const path = typeof p.source === 'string' ? p.source : p.source.path;
      if (typeof path === 'string' && (typeof p.source === 'string' || p.source.source === 'local')) {
        add({ kind: 'plugin', dir: cleanDir(path), name: p.name });
      } else add({ kind: 'plugin', dir: '', name: p.name, external: true });
    }
  }
  if (items.length === 0) {
    const paths = new Set(files.map((f) => f.path));
    if (paths.has('.claude-plugin/plugin.json') || paths.has('plugin.json')) {
      add({ kind: 'plugin', dir: '' });
    } else if (paths.has('SKILL.md')) {
      add({ kind: 'skill', dir: '' });
    }
  }
  return items;
};

/** The files under `dir`, re-rooted. `dir === ''` returns every file. */
export const extractSubtree = (files: readonly PluginFile[], dir: string): PluginFile[] => {
  if (dir === '') return [...files];
  const prefix = `${dir}/`;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
};
