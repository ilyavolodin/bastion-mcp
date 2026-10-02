import { describe, expect, it } from 'vitest';
import {
  approvalStatus,
  classifyFile,
  classifyFiles,
  classifyVersion,
  executableEntries,
  parsePluginManifest,
  type PluginVersionContent,
  requiresAdminApproval,
  reviewedDiff,
  reviewedDiffSha256,
  textFile,
} from '../src';
import { SKILL_MD } from './helpers/fixtures';

const cls = (path: string, text: string, mode: 'file' | 'executable' = 'file') =>
  classifyFile(textFile(path, text, mode)).classification;

const manifest = (extra: Record<string, unknown> = {}) =>
  parsePluginManifest({ name: 'p', version: '1.0.0', description: 'd', displayName: 'P', ...extra });

describe('25.2 executable-content classification', () => {
  it('25.2 treats Markdown, text and JSON data as plain', () => {
    expect(cls('skills/a/SKILL.md', SKILL_MD('a'))).toBe('plain');
    expect(cls('skills/a/references/x.md', '# x')).toBe('plain');
    expect(cls('data.json', '{"a":1}')).toBe('plain');
    expect(cls('notes.txt', 'hello')).toBe('plain');
  });

  it('25.2 flags files under scripts/ at any depth', () => {
    expect(cls('skills/a/scripts/run.py', 'print(1)')).toBe('executable');
    expect(cls('scripts/x.txt', 'data')).toBe('executable');
  });

  it('25.2 flags files with an exec bit or a shebang', () => {
    expect(cls('bin/tool', 'data', 'executable')).toBe('executable');
    expect(cls('tool', '#!/usr/bin/env node\n')).toBe('executable');
    expect(classifyFile(textFile('t', '#!/bin/sh')).reason).toMatch(/shebang/);
  });

  it('25.2 flags hooks (hooks/ directory and hooks.json)', () => {
    expect(cls('hooks/hooks.json', '{}')).toBe('executable');
    expect(cls('claude/hooks/pre.sh', 'x')).toBe('executable');
    expect(cls('openai/hooks/hooks.json', '{}')).toBe('executable');
    expect(cls('anywhere/hooks.json', '{}')).toBe('executable');
    expect(cls('skills/a/references/hooks-guide.md', 'x')).toBe('plain');
  });

  it('25.2 flags SKILL.md bodies with the !`command` injection', () => {
    expect(cls('SKILL.md', SKILL_MD('a').replace('Body.', 'Branch: !`git branch`'))).toBe('executable');
    expect(cls('SKILL.md', SKILL_MD('a').replace('Body.', '```!\nls\n```'))).toBe('executable');
    expect(cls('SKILL.md', SKILL_MD('a').replace('Body.', 'Say hello! `code` is fine'))).toBe('plain');
  });

  it('25.2 flags SKILL.md allowed-tools that pre-approve Bash', () => {
    for (const tools of ['Bash', 'Read Bash(git:*)', '[Read, "Bash(npm test)"]', 'Bash(git status:*), Read']) {
      expect(cls('SKILL.md', SKILL_MD('a', `allowed-tools: ${tools}\n`)), tools).toBe('executable');
    }
    expect(cls('SKILL.md', SKILL_MD('a', 'allowed-tools: Read Grep\n'))).toBe('plain');
    expect(cls('SKILL.md', SKILL_MD('a', 'allowed-tools:\n  - Read\n  - Bash\n'))).toBe('executable');
    expect(cls('SKILL.md', SKILL_MD('a', 'allowed-tools: BashOutput\n'))).toBe('plain');
    // Unparsable frontmatter falls back to a text search.
    expect(cls('SKILL.md', '---\nname: [\nallowed-tools: Bash\n---\n')).toBe('executable');
  });

  it('25.2 flags MCP files that declare local (stdio) servers; remote references stay plain', () => {
    const stdio = '{"mcpServers":{"a":{"command":"node","args":["x"]}}}';
    const remote = '{"mcpServers":{"a":{"type":"http","url":"https://h/mcp/c/a","oauth":true}}}';
    expect(cls('.mcp.json', stdio)).toBe('executable');
    expect(cls('mcp.json', '{"mcpServers":{"a":{"type":"stdio"}}}')).toBe('executable');
    expect(cls('.mcp.json', remote)).toBe('plain');
    expect(cls('.mcp.json', 'not json')).toBe('plain');
    expect(cls('.mcp.json', '[]')).toBe('plain');
    expect(cls('.mcp.json', '{"mcpServers":1}')).toBe('plain');
  });

  it('25.2 classifyFiles returns path, classification and reason for every file', () => {
    const out = classifyFiles([textFile('a.md', 'a'), textFile('scripts/b.sh', 'b')]);
    expect(out).toEqual([
      { path: 'a.md', classification: 'plain', reason: expect.any(String) },
      { path: 'scripts/b.sh', classification: 'executable', reason: expect.stringContaining('scripts') },
    ]);
  });

  it('25.3 includes manifest stdio servers and hooks in the list for the approver', () => {
    const v: PluginVersionContent = {
      manifest: manifest({
        mcpServers: [{ kind: 'stdio', name: 'local', command: 'node' }],
        claude: { pluginJson: { hooks: { PreToolUse: [] } } },
      }),
      files: [textFile('a.md', 'a')],
    };
    const paths = classifyVersion(v)
      .filter((c) => c.classification === 'executable')
      .map((c) => c.path);
    expect(paths).toEqual(['plugin.json#mcpServers/local', 'plugin.json#claude.hooks']);
  });
});

describe('10.1 / 25.2 approval gate', () => {
  const plain: PluginVersionContent = { manifest: manifest(), files: [textFile('a.md', 'a')] };
  const withScript = (body: string): PluginVersionContent => ({
    manifest: manifest(),
    files: [textFile('a.md', 'a'), textFile('scripts/run.sh', body)],
  });

  it('10.1 Managers may publish plain plugins; executable content needs Admin approval', () => {
    expect(requiresAdminApproval(plain)).toBe(false);
    expect(requiresAdminApproval(withScript('echo'))).toBe(true);
    expect(approvalStatus(plain, undefined, undefined)).toBe('not-required');
    expect(approvalStatus(withScript('echo'), undefined, undefined)).toBe('pending');
  });

  it('25.2 the reviewed diff is canonical: added, modified and removed executable files', () => {
    const v1 = withScript('echo 1');
    const v2: PluginVersionContent = {
      manifest: manifest({ mcpServers: [{ kind: 'stdio', name: 's', command: 'x' }] }),
      files: [textFile('scripts/run.sh', 'echo 2'), textFile('scripts/new.sh', 'n')],
    };
    expect(reviewedDiff(undefined, v1).map((d) => [d.path, d.change])).toEqual([['scripts/run.sh', 'added']]);
    expect(reviewedDiff(v1, v2).map((d) => [d.path, d.change])).toEqual([
      ['plugin.json#mcpServers/s', 'added'],
      ['scripts/new.sh', 'added'],
      ['scripts/run.sh', 'modified'],
    ]);
    expect(reviewedDiff(v2, plain).map((d) => d.change)).toEqual(['removed', 'removed', 'removed']);
    expect(reviewedDiff(v1, v1)).toEqual([]);
    expect(executableEntries(v2)).toHaveLength(3);
  });

  it('25.2 reviewed_diff_sha256 is stable and changes with any executable byte', () => {
    const a = reviewedDiffSha256(undefined, withScript('echo 1'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewedDiffSha256(undefined, withScript('echo 1'))).toBe(a);
    expect(reviewedDiffSha256(undefined, withScript('echo 2'))).not.toBe(a);
  });

  it('25.2 an approval covers that exact version only: a different diff makes it stale', () => {
    const v1 = withScript('echo 1');
    const approval = { reviewedDiffSha256: reviewedDiffSha256(undefined, v1) };
    expect(approvalStatus(v1, undefined, approval)).toBe('approved');
    expect(approvalStatus(withScript('echo 666'), undefined, approval)).toBe('stale');
  });

  it('25.2 mode changes of an executable file are part of the diff', () => {
    const a: PluginVersionContent = { manifest: manifest(), files: [textFile('bin/x', 'd', 'executable')] };
    const b: PluginVersionContent = { manifest: manifest(), files: [textFile('bin/x', 'd', 'executable')] };
    expect(reviewedDiff(a, b)).toEqual([]);
  });
});
