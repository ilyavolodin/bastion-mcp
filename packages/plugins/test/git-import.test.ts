import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRelease,
  commitRelease,
  diffTrees,
  discoverItems,
  extractSubtree,
  importPluginTree,
  initBareRepository,
  isEmptyDiff,
  PluginValidationError,
  planSourceSync,
  readGitTree,
  textFile,
} from '../src';
import { marketplaceInfo, RELEASE_TIME, SKILL_MD, sampleItems } from './helpers/items';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bastion-gi-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const repoWith = async (files: ReturnType<typeof textFile>[], name = 'repo.git') => {
  const gitdir = join(dir, name);
  await initBareRepository(gitdir);
  const commit = await commitRelease({ gitdir, files, seq: 1, releaseTime: RELEASE_TIME });
  return { gitdir, commit };
};

describe('25.3 import from git (local bare repository, no network)', () => {
  it('25.3 imports a marketplace repository at a ref and discovers its plugins', async () => {
    const gitdir = join(dir, 'market.git');
    const built = await buildRelease(sampleItems(), 1, RELEASE_TIME, {
      host: 'mcp.example.com',
      marketplace: marketplaceInfo,
      gitdir,
    });
    const tree = await readGitTree({ gitdir, ref: 'main' });
    expect(tree.commit).toBe(built.record.gitCommit);
    expect((await readGitTree({ gitdir, ref: 'release-1' })).commit).toBe(tree.commit);
    expect((await readGitTree({ gitdir, ref: tree.commit })).commit).toBe(tree.commit);
    expect((await readGitTree({ gitdir, ref: tree.commit.slice(0, 10) })).commit).toBe(tree.commit);

    const items = discoverItems(tree.files);
    expect(items.map((i) => [i.kind, i.dir, i.name])).toEqual(
      expect.arrayContaining([
        ['plugin', 'plugins/code-review', 'code-review'],
        ['plugin', 'plugins/toolbox', 'toolbox'],
        ['plugin', 'plugins/notes', 'notes'],
      ]),
    );
    const toolbox = extractSubtree(tree.files, 'plugins/toolbox');
    const imported = importPluginTree(toolbox);
    expect(imported.manifest.name).toBe('toolbox');
    expect(imported.manifest.mcpServers).toMatchObject([{ kind: 'stdio', name: 'lint' }]);
    expect(imported.files.find((f) => f.path.endsWith('run.sh'))?.mode).toBe('executable');
  });

  it('25.3 imports a plugin repository (root plugin.json) and a skill repository (root SKILL.md)', async () => {
    const plugin = await repoWith(
      [textFile('.claude-plugin/plugin.json', '{"name":"solo","version":"1.0.0"}')],
      'p.git',
    );
    expect(
      discoverItems((await readGitTree({ gitdir: plugin.gitdir, ref: 'main' })).files),
    ).toEqual([{ kind: 'plugin', dir: '' }]);
    const skill = await repoWith([textFile('SKILL.md', SKILL_MD('solo'))], 's.git');
    expect(discoverItems((await readGitTree({ gitdir: skill.gitdir, ref: 'main' })).files)).toEqual(
      [{ kind: 'skill', dir: '' }],
    );
    const none = await repoWith([textFile('README.md', 'x')], 'n.git');
    expect(discoverItems((await readGitTree({ gitdir: none.gitdir, ref: 'main' })).files)).toEqual(
      [],
    );
    expect(extractSubtree([textFile('a', '1')], '')).toHaveLength(1);
  });

  it('25.3 marks marketplace entries with sources outside the repository as external', () => {
    const items = discoverItems([
      textFile(
        '.claude-plugin/marketplace.json',
        JSON.stringify({
          plugins: [
            { name: 'far', source: { source: 'github', repo: 'a/b' } },
            { name: 'near', source: './x' },
          ],
        }),
      ),
      textFile(
        '.agents/plugins/marketplace.json',
        JSON.stringify({
          plugins: [
            { name: 'agent', source: { source: 'local', path: './y/' } },
            { name: 'git', source: { source: 'git', url: 'u' } },
          ],
        }),
      ),
    ]);
    expect(items).toEqual([
      { kind: 'plugin', dir: '', name: 'far', external: true },
      { kind: 'plugin', dir: 'x', name: 'near' },
      { kind: 'plugin', dir: 'y', name: 'agent' },
      { kind: 'plugin', dir: '', name: 'git', external: true },
    ]);
    expect(() => discoverItems([textFile('.claude-plugin/marketplace.json', '{bad')])).toThrow(
      /JSON/,
    );
  });

  it('25.2 rejects symlinks in a repository', async () => {
    const gitdir = join(dir, 'link.git');
    await initBareRepository(gitdir);
    const blob = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode('target') });
    const tree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '120000', path: 'link', oid: blob, type: 'blob' }],
    });
    const oid = await git.writeCommit({
      fs,
      gitdir,
      commit: {
        message: 'x',
        tree,
        parent: [],
        author: { name: 'a', email: 'a@b', timestamp: 1, timezoneOffset: 0 },
        committer: { name: 'a', email: 'a@b', timestamp: 1, timezoneOffset: 0 },
      },
    });
    await git.writeRef({ fs, gitdir, ref: 'refs/heads/main', value: oid, force: true });
    await expect(readGitTree({ gitdir, ref: 'main' })).rejects.toThrow(/symlinks/);
  });

  it('25.2 rejects a missing ref and enforces repository limits', async () => {
    const { gitdir } = await repoWith([textFile('a', '1'), textFile('b', '2')]);
    await expect(readGitTree({ gitdir, ref: 'nope' })).rejects.toThrow(PluginValidationError);
    await expect(
      readGitTree({
        gitdir,
        ref: 'main',
        limits: { maxFiles: 1, maxUnpackedBytes: 100, maxFileBytes: 10 },
      }),
    ).rejects.toThrow(/limits/);
  });
});

describe('25.3 tracked plugin source sync', () => {
  const v1 = [textFile('a.md', 'one'), textFile('b.md', 'two')];

  it('25.3 diffs trees by sha256 and mode', () => {
    const v2 = [
      textFile('a.md', 'ONE'),
      textFile('c.md', 'three'),
      textFile('b.md', 'two', 'executable'),
    ];
    const diff = diffTrees(v1, v2);
    expect(diff).toEqual({
      added: ['c.md'],
      modified: ['a.md', 'b.md'],
      removed: [],
      unchanged: [],
    });
    expect(diffTrees(v2, v1.slice(0, 1)).removed).toEqual(['b.md', 'c.md']);
    expect(isEmptyDiff(diffTrees(v1, [...v1].reverse()))).toBe(true);
    expect(diffTrees(undefined, v1).added).toEqual(['a.md', 'b.md']);
  });

  it('25.3 new upstream content becomes a DRAFT for review; unchanged content does nothing', () => {
    expect(planSourceSync({ lastCommit: 'c1', previous: v1, commit: 'c1', files: v1 })).toEqual({
      action: 'none',
      reason: 'same-commit',
    });
    expect(planSourceSync({ lastCommit: 'c1', previous: v1, commit: 'c2', files: v1 })).toEqual({
      action: 'none',
      reason: 'same-tree',
    });
    const plan = planSourceSync({
      lastCommit: 'c1',
      previous: v1,
      commit: 'c2',
      files: [...v1, textFile('n.md', 'n')],
    });
    expect(plan).toMatchObject({ action: 'draft', commit: 'c2', diff: { added: ['n.md'] } });
    expect(
      planSourceSync({ lastCommit: undefined, previous: undefined, commit: 'c1', files: v1 })
        .action,
    ).toBe('draft');
  });
});
