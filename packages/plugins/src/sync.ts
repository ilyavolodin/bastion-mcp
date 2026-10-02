import { fileSha256, type PluginFile } from './types';

export type TreeDiff = {
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: string[];
};

export const isEmptyDiff = (diff: TreeDiff): boolean =>
  diff.added.length + diff.modified.length + diff.removed.length === 0;

/** Pure diff of two file trees by content hash and mode (25.3). Paths are sorted. */
export const diffTrees = (
  before: readonly PluginFile[] | undefined,
  after: readonly PluginFile[],
): TreeDiff => {
  const key = (f: PluginFile): string => `${fileSha256(f)}:${f.mode}`;
  const old = new Map((before ?? []).map((f) => [f.path, key(f)]));
  const next = new Map(after.map((f) => [f.path, key(f)]));
  const diff: TreeDiff = { added: [], modified: [], removed: [], unchanged: [] };
  for (const [path, k] of next) {
    const prev = old.get(path);
    if (prev === undefined) diff.added.push(path);
    else if (prev !== k) diff.modified.push(path);
    else diff.unchanged.push(path);
  }
  for (const path of old.keys()) if (!next.has(path)) diff.removed.push(path);
  for (const list of Object.values(diff)) list.sort();
  return diff;
};

export type SyncPlan =
  | { action: 'none'; reason: 'same-commit' | 'same-tree' }
  | { action: 'draft'; commit: string; diff: TreeDiff };

/**
 * A tracked plugin source (25.3, 11.6): new upstream content becomes a DRAFT version for review;
 * nothing is published automatically. `previous` is the tree of the last imported commit.
 */
export const planSourceSync = (input: {
  lastCommit: string | undefined;
  previous: readonly PluginFile[] | undefined;
  commit: string;
  files: readonly PluginFile[];
}): SyncPlan => {
  if (input.lastCommit === input.commit) return { action: 'none', reason: 'same-commit' };
  const diff = diffTrees(input.previous, input.files);
  if (input.previous && isEmptyDiff(diff)) return { action: 'none', reason: 'same-tree' };
  return { action: 'draft', commit: input.commit, diff };
};
