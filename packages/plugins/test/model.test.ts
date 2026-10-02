import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  encodeText,
  enforceLimits,
  importPluginTree,
  isSemver,
  normalizePath,
  parseOpenAiYaml,
  parsePluginManifest,
  parseSkillMd,
  PluginValidationError,
  renderSkillMd,
  standaloneSkillPlugin,
  textFile,
} from '../src';
import { SKILL_MD } from './helpers/fixtures';

describe('25.2 skills: SKILL.md', () => {
  it('25.2 requires frontmatter name and description', () => {
    expect(() => parseSkillMd('# no frontmatter')).toThrow(PluginValidationError);
    expect(() => parseSkillMd('---\nname: a-b\n---\nbody')).toThrow(/description/);
    expect(() => parseSkillMd('---\ndescription: x\n---\nbody')).toThrow(/name/);
    expect(() => parseSkillMd('---\nname: Bad Name\ndescription: x\n---\n')).toThrow(/name/);
    expect(() => parseSkillMd('---\n- a\n---\n')).toThrow(/mapping/);
    expect(() => parseSkillMd('---\nname: [\n---\n')).toThrow(/YAML/);
    expect(() => parseSkillMd(`---\nname: a\ndescription: ${'x'.repeat(1025)}\n---\n`)).toThrow(/1024/);
  });

  it('25.2 keeps every other frontmatter key verbatim, including allowed-tools and context', () => {
    const parsed = parseSkillMd(
      SKILL_MD('lint', 'allowed-tools: Read Grep\ncontext: fork\nmetadata:\n  owner: [a, b]\n'),
    );
    expect(parsed.name).toBe('lint');
    expect(parsed.frontmatter['allowed-tools']).toBe('Read Grep');
    expect(parsed.frontmatter.context).toBe('fork');
    expect(parsed.frontmatter.metadata).toEqual({ owner: ['a', 'b'] });
    expect(parsed.body).toContain('# lint');
  });

  it('25.3 the frontmatter form round-trips through renderSkillMd', () => {
    const parsed = parseSkillMd(SKILL_MD('x', 'allowed-tools: Read\n'));
    const again = parseSkillMd(renderSkillMd(parsed.frontmatter, parsed.body));
    expect(again.frontmatter).toEqual(parsed.frontmatter);
    expect(again.body).toBe(parsed.body);
  });

  it('25.2 accepts an optional agents/openai.yaml mapping and rejects other shapes', () => {
    expect(parseOpenAiYaml('interface:\n  display_name: X\npolicy: {}\n')).toMatchObject({
      interface: { display_name: 'X' },
    });
    expect(parseOpenAiYaml('')).toEqual({});
    expect(() => parseOpenAiYaml('- a')).toThrow(/mapping/);
    expect(() => parseOpenAiYaml('a: [')).toThrow(/YAML/);
  });
});

describe('25.2 plugin manifest', () => {
  const base = { name: 'my-plugin', version: '1.0.0', description: 'd', displayName: 'My Plugin' };

  it('25.2 accepts kebab-case names and semver versions', () => {
    expect(parsePluginManifest(base).skills).toEqual([]);
    expect(isSemver('1.2.3-rc.1+build.5')).toBe(true);
  });

  it('25.2 rejects non-semver version labels and non-kebab names for plugins', () => {
    for (const version of ['v1', '1.0', 'latest', '01.0.0']) {
      expect(() => parsePluginManifest({ ...base, version })).toThrow(PluginValidationError);
    }
    expect(() => parsePluginManifest({ ...base, name: 'My_Plugin' })).toThrow(PluginValidationError);
  });

  it('25.2 models skill references (pinned or following current) and inline skills', () => {
    const m = parsePluginManifest({
      ...base,
      skills: [
        { kind: 'ref', slug: 's1', version: '2.0.0' },
        { kind: 'ref', slug: 's2' },
        { kind: 'inline', path: 'skills/mine' },
      ],
    });
    expect(m.skills).toHaveLength(3);
    expect(() =>
      parsePluginManifest({ ...base, skills: [{ kind: 'inline', path: '../escape' }] }),
    ).toThrow(PluginValidationError);
  });

  it('25.2 models Bastion references, external remote URLs and local stdio servers', () => {
    const m = parsePluginManifest({
      ...base,
      mcpServers: [
        { kind: 'bastion', slug: 'github' },
        { kind: 'remote', name: 'docs', url: 'https://x.example/mcp' },
        { kind: 'stdio', name: 'local', command: 'node' },
      ],
    });
    expect(m.mcpServers[2]).toMatchObject({ args: [], env: {} });
    expect(() =>
      parsePluginManifest({ ...base, mcpServers: [{ kind: 'remote', name: 'x', url: 'ftp://x' }] }),
    ).toThrow(PluginValidationError);
  });

  it('25.2 rejects duplicate MCP server names', () => {
    expect(() =>
      parsePluginManifest({
        ...base,
        mcpServers: [
          { kind: 'bastion', slug: 'a' },
          { kind: 'remote', name: 'a', url: 'https://x.example' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('25.2 publishes a standalone skill as a plugin of the same name with only that skill', () => {
    const plugin = standaloneSkillPlugin({
      skillName: 'notes',
      version: '1.0.0',
      description: 'Notes',
      skillFiles: [textFile('SKILL.md', SKILL_MD('notes')), textFile('references/a.md', 'a')],
    });
    expect(plugin.manifest.name).toBe('notes');
    expect(plugin.manifest.skills).toEqual([{ kind: 'inline', path: 'skills/notes' }]);
    expect(plugin.files.map((f) => f.path)).toEqual(['skills/notes/SKILL.md', 'skills/notes/references/a.md']);
  });
});

describe('25.2 paths and limits', () => {
  it('25.2 normalizes paths and rejects absolute, .., backslash, NUL and .git paths', () => {
    expect(normalizePath('./a//b/./c.md')).toBe('a/b/c.md');
    for (const bad of ['/etc/passwd', 'C:/x', '../x', 'a/../../x', 'a\\b', 'a\0b', '.git/config', 'a/.GIT/x', '', '.', 'dir/']) {
      expect(() => normalizePath(bad), bad).toThrow(PluginValidationError);
    }
  });

  it('25.2 property: normalized paths never contain .. or leading slashes and are stable', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z0-9._ -]{1,8}$/), { minLength: 1, maxLength: 5 }), (parts) => {
        try {
          const out = normalizePath(parts.join('/'));
          expect(out.startsWith('/')).toBe(false);
          expect(out.split('/')).not.toContain('..');
          expect(normalizePath(out)).toBe(out);
        } catch (error) {
          expect(error).toBeInstanceOf(PluginValidationError);
        }
      }),
    );
  });

  const limits = { maxUnpackedBytes: 100, maxFiles: 3, maxFileBytes: 60 };

  it('25.2 enforces the file count, per-file and unpacked limits', () => {
    const f = (path: string, n: number) => ({ path, content: new Uint8Array(n), mode: 'file' as const });
    expect(() => enforceLimits([f('a', 1), f('b', 1), f('c', 1)], limits)).not.toThrow();
    expect(() => enforceLimits([f('a', 1), f('b', 1), f('c', 1), f('d', 1)], limits)).toThrow(/files/);
    expect(() => enforceLimits([f('a', 61)], limits)).toThrow(/larger/);
    expect(() => enforceLimits([f('a', 60), f('b', 50)], limits)).toThrow(/unpacked/);
    expect(() => enforceLimits([f('a', 1), f('a', 1)], limits)).toThrow(/duplicate/);
    expect(() => enforceLimits([f('./a', 1)], limits)).toThrow(/normalized/);
  });

  it('25.2 uses the PLUGIN_LIMITS defaults (20 MiB, 2000 files, 5 MiB per file)', () => {
    const big = { path: 'big.bin', content: new Uint8Array(5 * 1024 * 1024 + 1), mode: 'file' as const };
    expect(() => enforceLimits([big])).toThrow(/larger/);
    const many = Array.from({ length: 2001 }, (_, i) => textFile(`f${i}`, ''));
    expect(() => enforceLimits(many)).toThrow(/files/);
  });
});

describe('25.3 import of an existing plugin directory', () => {
  it('25.3 converts a Claude-layout plugin to the authored form', () => {
    const imported = importPluginTree([
      textFile('.claude-plugin/plugin.json', JSON.stringify({ name: 'x-plugin', version: '2.1.0', description: 'D' })),
      textFile('.mcp.json', JSON.stringify({ mcpServers: { a: { url: 'https://a.example/mcp' }, b: { command: 'node', args: ['s.js'] } } })),
      textFile('skills/one/SKILL.md', SKILL_MD('one')),
      textFile('commands/go.md', 'go'),
      textFile('hooks/hooks.json', '{}'),
      textFile('apps.json', '{}'),
      textFile('README.md', 'hi'),
    ]);
    expect(imported.manifest).toMatchObject({
      name: 'x-plugin',
      version: '2.1.0',
      skills: [{ kind: 'inline', path: 'skills/one' }],
      mcpServers: [
        { kind: 'remote', name: 'a' },
        { kind: 'stdio', name: 'b', command: 'node', args: ['s.js'] },
      ],
    });
    expect(imported.files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'claude/commands/go.md',
      'claude/hooks/hooks.json',
      'openai/apps.json',
      'skills/one/SKILL.md',
    ]);
  });

  it('25.2 rejects imported plugins with non-semver versions and nameless manifests', () => {
    expect(() =>
      importPluginTree([textFile('plugin.json', JSON.stringify({ name: 'p', version: 'latest' }))]),
    ).toThrow(/semver/);
    expect(() => importPluginTree([textFile('README.md', 'x')])).toThrow(/name/);
    expect(importPluginTree([textFile('README.md', 'x')], { name: 'fallback' }).manifest.version).toBe('0.0.0');
    expect(() => importPluginTree([textFile('plugin.json', '{bad')])).toThrow(/JSON/);
    expect(encodeText('x')).toBeInstanceOf(Uint8Array);
  });
});
