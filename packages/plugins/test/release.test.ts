import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@bastion-mcp/core';
import git from 'isomorphic-git';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRelease,
  buildReleaseContent,
  decodeUtf8,
  httpsManifestSha256,
  importZip,
  initBareRepository,
  parsePluginManifest,
  readGitTree,
  renderHttpsManifest,
  textFile,
} from '../src';
import { RELEASE_TIME, marketplaceInfo, plainItem, sampleItems } from './helpers/fixtures';

const ctx = { host: 'mcp.example.com', marketplace: marketplaceInfo };
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('25.4 / 25.5 deterministic releases', () => {
  it('25.5 the same release built twice has identical commit SHA, manifests and archive digests', async () => {
    const a = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
    const b = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
    expect(a.record).toEqual(b.record);
    expect(Buffer.from(a.claudeManifest).equals(Buffer.from(b.claudeManifest))).toBe(true);
    for (const [name, archive] of a.archives) {
      expect(Buffer.from(archive.bytes).equals(Buffer.from(b.archives.get(name)?.bytes ?? new Uint8Array()))).toBe(true);
      expect(archive.sha256).toBe(sha256Hex(archive.bytes));
    }
  });

  it('23.2 builds the same release in SEPARATE PROCESSES with identical SHAs and digests', async () => {
    const script = fileURLToPath(new URL('./helpers/build-release-script.ts', import.meta.url));
    const run = (): { first: unknown; second: unknown; pid: number } =>
      JSON.parse(
        execFileSync(process.execPath, ['--import', 'tsx', script], {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, TZ: 'Pacific/Auckland' },
        }),
      );
    const one = run();
    const two = run();
    expect(one.pid).not.toBe(two.pid);
    expect(one.first).toEqual(two.first);
    expect(one.second).toEqual(two.second);
    // And equal to this process (which runs in another timezone).
    const here = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
    expect(one.first).toEqual(here.record);
  }, 120_000);

  it('25.5 different content or a different release time changes the commit', async () => {
    const a = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
    const later = await buildRelease(sampleItems(), 1, new Date(RELEASE_TIME.getTime() + 1000), ctx);
    const fewer = await buildRelease(sampleItems().slice(1), 1, RELEASE_TIME, ctx);
    expect(later.record.gitCommit).not.toBe(a.record.gitCommit);
    expect(fewer.record.gitCommit).not.toBe(a.record.gitCommit);
    expect(later.record.claudeManifestSha256).toBe(a.record.claudeManifestSha256);
  });

  it('25.5 the host is part of the build (URLs), so replicas must share it', async () => {
    const a = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
    const other = await buildRelease(sampleItems(), 1, RELEASE_TIME, { ...ctx, host: 'other.example.com' });
    expect(other.record.gitCommit).not.toBe(a.record.gitCommit);
  });

  it('25.5 records the manifest sha256 of both manifests and one archive digest per plugin', async () => {
    const built = await buildRelease(sampleItems(), 3, RELEASE_TIME, { ...ctx, parentCommit: 'a'.repeat(40) });
    expect(built.record.claudeManifestSha256).toBe(sha256Hex(built.claudeManifest));
    expect(built.record.agentsManifestSha256).toBe(sha256Hex(built.agentsManifest));
    expect(Object.keys(built.record.archives).sort()).toEqual(['code-review', 'notes', 'toolbox']);
    expect(built.record.archives.notes).toEqual({ version: '1.0.0', sha256: built.archives.get('notes')?.sha256 });
    expect(built.record.items.map((i) => [i.name, i.policy])).toEqual([
      ['code-review', 'installedByDefault'],
      ['toolbox', 'required'],
      ['notes', 'available'],
    ]);
  });

  it('25.5 archives hold the plugin at the archive root', async () => {
    const built = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
    const files = importZip(built.archives.get('notes')?.bytes ?? new Uint8Array(), { stripWrapper: false });
    expect(files.map((f) => f.path)).toEqual(['.claude-plugin/plugin.json', 'plugin.json', 'skills/notes/SKILL.md']);
    const tool = importZip(built.archives.get('toolbox')?.bytes ?? new Uint8Array(), { stripWrapper: false });
    expect(tool.find((f) => f.path.endsWith('run.sh'))?.mode).toBe('executable');
  });

  it('25.5 rejects invalid release numbers', async () => {
    await expect(buildRelease([], 0, RELEASE_TIME, ctx)).rejects.toThrow(/seq/);
  });
});

describe('25.5 git commit', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bastion-rel-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('25.5 writes author, committer, +0000 timezone, message, parent, main and release tags', async () => {
    const gitdir = join(dir, 'repo.git');
    const r1 = await buildRelease(sampleItems(), 1, RELEASE_TIME, { ...ctx, gitdir });
    const r2 = await buildRelease(sampleItems().slice(0, 1), 2, new Date('2026-10-02T08:30:00Z'), {
      ...ctx,
      gitdir,
      parentCommit: r1.record.gitCommit,
    });
    const commit = await git.readCommit({ fs, gitdir, oid: r2.record.gitCommit });
    expect(commit.commit.author).toEqual({
      name: 'Bastion',
      email: 'noreply@bastion-mcp.github.io',
      timestamp: Math.floor(new Date('2026-10-02T08:30:00Z').getTime() / 1000),
      timezoneOffset: 0,
    });
    expect(commit.commit.committer).toEqual(commit.commit.author);
    expect(commit.commit.message.trim()).toBe('Release 2');
    expect(commit.commit.parent).toEqual([r1.record.gitCommit]);
    expect(await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' })).toBe(r2.record.gitCommit);
    expect(await git.resolveRef({ fs, gitdir, ref: 'refs/tags/release-1' })).toBe(r1.record.gitCommit);
    expect(await git.resolveRef({ fs, gitdir, ref: 'refs/tags/release-2' })).toBe(r2.record.gitCommit);
    const first = await git.readCommit({ fs, gitdir, oid: r1.record.gitCommit });
    expect(first.commit.parent).toEqual([]);
  });

  it.skipIf(!hasGit)('25.5 the repository is valid for the git binary and keeps the exec bit', async () => {
    const gitdir = join(dir, 'repo.git');
    const built = await buildRelease(sampleItems(), 1, RELEASE_TIME, { ...ctx, gitdir });
    execFileSync('git', ['--git-dir', gitdir, 'fsck', '--strict'], { stdio: 'pipe' });
    const tree = execFileSync('git', ['--git-dir', gitdir, 'ls-tree', '-r', 'main'], { encoding: 'utf8' });
    expect(tree).toContain('100755');
    expect(tree).toContain('plugins/toolbox/skills/lint/scripts/run.sh');
    const log = execFileSync('git', ['--git-dir', gitdir, 'log', '-1', '--format=%H|%an <%ae>|%cn|%ci|%s'], { encoding: 'utf8' }).trim();
    expect(log).toBe(`${built.record.gitCommit}|Bastion <noreply@bastion-mcp.github.io>|Bastion|2026-10-01 12:00:00 +0000|Release 1`);
    const read = await readGitTree({ gitdir, ref: 'refs/tags/release-1' });
    expect(read.commit).toBe(built.record.gitCommit);
    expect(read.files.map((f) => f.path)).toEqual(built.files.map((f) => f.path));
  });

  it('25.5 initBareRepository is idempotent', async () => {
    const gitdir = join(dir, 'x.git');
    await initBareRepository(gitdir);
    await initBareRepository(gitdir);
    expect(fs.existsSync(join(gitdir, 'HEAD'))).toBe(true);
  });
});

describe('25.5 HTTPS manifest', () => {
  it('25.5 replaces each source with an archive source on the same origin with its sha256', () => {
    const content = buildReleaseContent(sampleItems(), ctx);
    const record = { archives: content.archiveRecord };
    const manifest = JSON.parse(decodeUtf8(renderHttpsManifest(content.claudeManifest, record, { host: 'mcp.example.com', slug: 'acme-tools' })) ?? '');
    expect(manifest.plugins[2]).toEqual({
      name: 'notes',
      source: {
        source: 'archive',
        url: 'https://mcp.example.com/plugins/acme-tools/archives/notes-1.0.0.zip',
        sha256: content.archiveRecord.notes?.sha256,
      },
      description: 'Note taking',
    });
  });

  it('25.5 the manifest digest is stable and tied to the archive digests', () => {
    const a = buildReleaseContent(sampleItems(), ctx);
    const b = buildReleaseContent(sampleItems(), ctx);
    const opts = { host: 'mcp.example.com', slug: 'acme-tools' };
    expect(httpsManifestSha256(a.claudeManifest, { archives: a.archiveRecord }, opts)).toBe(
      httpsManifestSha256(b.claudeManifest, { archives: b.archiveRecord }, opts),
    );
    const changed = buildReleaseContent(
      [{ ...plainItem(), files: [textFile('skills/notes/SKILL.md', '---\nname: notes\ndescription: changed\n---\n')] }],
      ctx,
    );
    expect(changed.archiveRecord.notes?.sha256).not.toBe(a.archiveRecord.notes?.sha256);
  });

  it('25.5 fails when the release has no archive for a plugin', () => {
    const content = buildReleaseContent(sampleItems(), ctx);
    expect(() => renderHttpsManifest(content.claudeManifest, { archives: {} }, { host: 'h', slug: 's' })).toThrow(/no archive/);
  });

  it('25.5 non-UTF8 manifest bytes are rejected', () => {
    expect(() => renderHttpsManifest(new Uint8Array([0xff, 0xfe]), { archives: {} }, { host: 'h', slug: 's' })).toThrow(/UTF-8/);
    expect(parsePluginManifest(plainItem().manifest).name).toBe('notes');
  });
});
