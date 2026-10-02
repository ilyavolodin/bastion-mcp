import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  archiveDownloadEvent,
  buildSkillIndex,
  classifyClient,
  getSkill,
  gitFetchEvent,
  listSkills,
  loadVersionFiles,
  MemoryBlobStore,
  MemoryCatalogFileStore,
  manifestFetchEvent,
  parseSkillUri,
  readSkillResource,
  resolveCatalogRoute,
  SKILLS_CAPABILITY,
  SKILLS_EXTENSION_ID,
  saveVersionFiles,
  textFile,
} from '../src';
import { plainItem, reviewItem, toolboxItem } from './helpers/items';

describe('25.8 skills over MCP', () => {
  const index = buildSkillIndex(
    [
      { marketplace: 'acme-tools', item: reviewItem() },
      { marketplace: 'other', item: reviewItem() }, // same plugin in a second marketplace: first wins
      { marketplace: 'acme-tools', item: toolboxItem() },
      { marketplace: 'acme-tools', item: plainItem() },
    ],
    'mcp.example.com',
  );

  it('25.8 declares the io.modelcontextprotocol/skills extension with directoryRead', () => {
    expect(SKILLS_EXTENSION_ID).toBe('io.modelcontextprotocol/skills');
    expect(SKILLS_CAPABILITY).toEqual({ directoryRead: true });
  });

  it('25.8 skills/list answers with skill://<plugin>/<skill>/SKILL.md URIs from visible marketplaces', () => {
    expect(listSkills(index).skills.map((s) => s.uri)).toEqual([
      'skill://code-review/review/SKILL.md',
      'skill://code-review/style-guide/SKILL.md',
      'skill://notes/notes/SKILL.md',
      'skill://toolbox/lint/SKILL.md',
    ]);
    expect(listSkills(index).skills[0]).toMatchObject({
      name: 'review',
      plugin: 'code-review',
      description: 'Does review things',
    });
    expect(listSkills(buildSkillIndex([], 'h')).skills).toEqual([]);
  });

  it('25.8 skills/get returns the skill with every file, by URI or by plugin and name', () => {
    const byUri = getSkill(index, { uri: 'skill://code-review/review/SKILL.md' });
    expect(byUri?.files.map((f) => f.uri)).toEqual([
      'skill://code-review/review/SKILL.md',
      'skill://code-review/review/references/checklist.md',
    ]);
    expect(byUri?.files[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect(getSkill(index, { plugin: 'notes', name: 'notes' })?.uri).toBe(
      'skill://notes/notes/SKILL.md',
    );
    expect(getSkill(index, { uri: 'skill://nope/x/SKILL.md' })).toBeUndefined();
    expect(getSkill(index, { uri: 'garbage' })).toBeUndefined();
    expect(getSkill(index, { plugin: 'x', name: 'y' })).toBeUndefined();
  });

  it("25.8 resources/read answers files and directories under skill://, and nothing outside the caller's marketplaces", () => {
    const file = readSkillResource(index, 'skill://toolbox/lint/scripts/run.sh');
    expect(file?.contents).toEqual([
      {
        uri: 'skill://toolbox/lint/scripts/run.sh',
        mimeType: 'text/plain',
        text: '#!/bin/sh\necho lint\n',
      },
    ]);
    const dir = readSkillResource(index, 'skill://code-review/style-guide/');
    expect(dir?.contents.map((c) => c.uri)).toEqual([
      'skill://code-review/style-guide/SKILL.md',
      'skill://code-review/style-guide/assets/rules.txt',
    ]);
    expect(
      readSkillResource(index, 'skill://code-review/style-guide/assets')?.contents,
    ).toHaveLength(1);
    expect(readSkillResource(index, 'skill://code-review/review/missing.md')).toBeUndefined();
    expect(readSkillResource(index, 'skill://hidden/skill/SKILL.md')).toBeUndefined();
    expect(readSkillResource(index, 'file:///etc/passwd')).toBeUndefined();
    expect(readSkillResource(index, 'skill://code-review/review/../../x')).toBeUndefined();
    expect(parseSkillUri('skill://a/b')).toEqual({ plugin: 'a', skill: 'b', path: '' });
  });

  it('25.8 binary files come back as base64 blobs', () => {
    const item = {
      ...plainItem(),
      files: [
        ...plainItem().files,
        {
          path: 'skills/notes/assets/icon.png',
          content: new Uint8Array([0xff, 0x00, 0x89]),
          mode: 'file' as const,
        },
      ],
    };
    const idx = buildSkillIndex([{ marketplace: 'm', item }], 'h');
    expect(readSkillResource(idx, 'skill://notes/notes/assets/icon.png')?.contents[0]).toEqual({
      uri: 'skill://notes/notes/assets/icon.png',
      mimeType: 'application/octet-stream',
      blob: Buffer.from([0xff, 0, 0x89]).toString('base64'),
    });
  });

  it('25.8 skills with unreadable SKILL.md are not advertised', () => {
    const item = {
      ...plainItem(),
      files: [
        textFile('skills/notes/SKILL.md', 'no frontmatter'),
        textFile('skills/notes/b.json', '{}'),
      ],
    };
    expect(listSkills(buildSkillIndex([{ marketplace: 'm', item }], 'h')).skills).toEqual([]);
  });
});

describe('25.8 /mcp/c/{catalogSlug} resolution', () => {
  const own = { id: 'own', state: 'active' };
  const team = { id: 'team', state: 'active' };

  it("25.8 prefers the caller's own installation, then a team installation", () => {
    expect(
      resolveCatalogRoute({
        ownInstallation: own,
        teamInstallation: team,
        visible: true,
        needsSetup: false,
      }),
    ).toEqual({ action: 'existing', installation: own, source: 'own' });
    expect(
      resolveCatalogRoute({ teamInstallation: team, visible: false, needsSetup: true }),
    ).toEqual({ action: 'existing', installation: team, source: 'team' });
  });

  it('25.8 creates a user installation with origin = plugin on the first request when the entry is visible', () => {
    expect(resolveCatalogRoute({ visible: true, needsSetup: false })).toEqual({
      action: 'create',
      origin: 'plugin',
      scope: 'user',
    });
  });

  it('25.8 starts in needs_setup when the entry needs setup', () => {
    expect(resolveCatalogRoute({ visible: true, needsSetup: true })).toEqual({
      action: 'needs-setup',
      origin: 'plugin',
      scope: 'user',
      state: 'needs_setup',
    });
  });

  it('25.8 answers not-visible when there is no installation and the entry is hidden', () => {
    expect(resolveCatalogRoute({ visible: false, needsSetup: false })).toEqual({
      action: 'not-visible',
    });
  });
});

describe('25.9 distribution events', () => {
  const base = {
    ts: new Date('2026-10-01T00:00:00Z'),
    principalId: 'u1',
    marketplaceId: 'm1',
    releaseSeq: 3,
    userAgent: 'git/2.4',
  };

  it('25.9 builds git fetch, manifest fetch and archive download events', () => {
    expect(gitFetchEvent(base)).toMatchObject({
      channel: 'git',
      action: 'git_fetch',
      principalId: 'u1',
      marketplaceId: 'm1',
      releaseSeq: 3,
      userAgent: 'git/2.4',
    });
    expect(manifestFetchEvent(base)).toMatchObject({ channel: 'https', action: 'manifest_fetch' });
    expect(archiveDownloadEvent(base)).toMatchObject({
      channel: 'https',
      action: 'archive_download',
    });
  });

  it('25.9 classifies clients from the user agent', () => {
    expect(classifyClient('claude-cli/2.1.0 (external)')).toBe('claude-code');
    expect(classifyClient('Claude Desktop/1.0')).toBe('claude-desktop');
    expect(classifyClient('codex_cli_rs/0.5')).toBe('codex');
    expect(classifyClient('ChatGPT-User')).toBe('chatgpt');
    expect(classifyClient('git/2.55.0')).toBe('git');
    expect(classifyClient('Mozilla/5.0')).toBe('browser');
    expect(classifyClient(null)).toBe('other');
  });

  const at = (
    min: number,
    principalId: string | null,
    releaseSeq: number | null,
    userAgent: string,
  ) => ({
    ts: new Date(Date.UTC(2026, 9, 1, 0, min)),
    principalId,
    releaseSeq,
    userAgent,
  });

  it('25.9 aggregates installs and updates per client and counts users on an old release', () => {
    const usage = aggregateUsage(
      [
        at(5, 'u1', 1, 'claude-cli/2'), // install
        at(10, 'u1', 1, 'claude-cli/2'), // refetch, no update
        at(20, 'u1', 2, 'claude-cli/2'), // update
        at(1, 'u2', 1, 'codex/1'), // install
        at(30, 'u3', 2, 'git/2'), // install
        at(31, 'u3', 3, 'git/2'), // update
        at(32, null, null, 'curl/8'), // anonymous: counted as a fetch only
      ],
      { latestSeq: 3 },
    );
    expect(usage.perClient['claude-code']).toEqual({
      installs: 1,
      updates: 1,
      fetches: 3,
      users: 1,
    });
    expect(usage.perClient.codex).toEqual({ installs: 1, updates: 0, fetches: 1, users: 1 });
    expect(usage.perClient.git).toEqual({ installs: 1, updates: 1, fetches: 2, users: 1 });
    expect(usage.perClient.other).toEqual({ installs: 0, updates: 0, fetches: 1, users: 0 });
    expect(usage.totalUsers).toBe(3);
    expect(usage.usersOnOldRelease).toBe(2); // u1 on 2 and u2 on 1; u3 is current
  });

  it('25.9 handles an empty history', () => {
    expect(aggregateUsage([], { latestSeq: 1 })).toEqual({
      perClient: {},
      totalUsers: 0,
      usersOnOldRelease: 0,
    });
  });
});

describe('25.2 / 11.1 file storage', () => {
  it('25.2 stores content-addressed blobs and classified rows, and loads them back', async () => {
    const stores = { blobs: new MemoryBlobStore(), files: new MemoryCatalogFileStore() };
    const rows = await saveVersionFiles(stores, 'v1', [
      textFile('SKILL.md', '---\nname: a\ndescription: d\n---\n'),
      textFile('scripts/run.sh', 'echo'),
      textFile('copy.md', '---\nname: a\ndescription: d\n---\n'),
    ]);
    expect(rows.map((r) => [r.path, r.classification])).toEqual([
      ['SKILL.md', 'plain'],
      ['copy.md', 'plain'],
      ['scripts/run.sh', 'executable'],
    ]);
    expect(stores.blobs.blobs.size).toBe(2); // identical bodies share one blob
    const loaded = await loadVersionFiles(stores, 'v1');
    expect(loaded.map((f) => f.path)).toEqual(['SKILL.md', 'copy.md', 'scripts/run.sh']);
  });

  it('11.1 published versions are immutable', async () => {
    const stores = { blobs: new MemoryBlobStore(), files: new MemoryCatalogFileStore() };
    await saveVersionFiles(stores, 'v1', [textFile('a.md', 'a')]);
    stores.files.published.add('v1');
    await expect(saveVersionFiles(stores, 'v1', [textFile('a.md', 'b')])).rejects.toThrow(
      /immutable/,
    );
  });

  it('25.2 enforces the limits on save and fails on missing blobs', async () => {
    const stores = { blobs: new MemoryBlobStore(), files: new MemoryCatalogFileStore() };
    await expect(saveVersionFiles(stores, 'v', [textFile('../x', 'a')])).rejects.toThrow();
    await saveVersionFiles(stores, 'v', [textFile('a.md', 'a')]);
    stores.blobs.blobs.clear();
    await expect(loadVersionFiles(stores, 'v')).rejects.toThrow(/blob missing/);
  });
});
