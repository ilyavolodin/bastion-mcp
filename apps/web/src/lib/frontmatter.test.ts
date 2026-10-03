import { describe, expect, it } from 'vitest';
import {
  isExecutablePath,
  parseSkill,
  SKILL_NAME_PATTERN,
  serializeSkill,
  validateFrontmatter,
} from './frontmatter';

const SKILL =
  '---\nname: pdf-tools\ndescription: Work with PDFs\nlicense: MIT\n---\n# Body\n\ntext\n';

describe('SKILL.md frontmatter (25.2)', () => {
  it('reads name, description and keeps the other keys', () => {
    const p = parseSkill(SKILL);
    expect(p.error).toBeNull();
    expect(p.frontmatter).toEqual({
      name: 'pdf-tools',
      description: 'Work with PDFs',
      extra: { license: 'MIT' },
    });
    expect(p.body).toBe('# Body\n\ntext\n');
  });

  it('reads files with Windows line endings', () => {
    const p = parseSkill(SKILL.replace(/\n/g, '\r\n'));
    expect(p.error).toBeNull();
    expect(p.frontmatter.name).toBe('pdf-tools');
  });

  it('reports a file that does not start with a frontmatter block, keeping the text as the body', () => {
    const p = parseSkill('# Just text');
    expect(p.error).toBe('SKILL.md must start with a --- frontmatter block');
    expect(p.body).toBe('# Just text');
    expect(p.frontmatter).toEqual({ name: '', description: '', extra: {} });
  });

  it('reports invalid YAML and keeps the body', () => {
    const p = parseSkill('---\nname: [unclosed\n---\nbody');
    expect(p.error).toEqual(expect.any(String));
    expect(p.error).not.toBeNull();
    expect(p.body).toBe('body');
  });

  it('treats a non-string name or description as empty', () => {
    const p = parseSkill('---\nname: 12\ndescription: [a]\n---\n');
    expect(p.frontmatter.name).toBe('');
    expect(p.frontmatter.description).toBe('');
  });

  it('writes the name and description first, then the extra keys, and reads them back', () => {
    const text = serializeSkill(
      { name: 'a', description: 'd', extra: { license: 'MIT', tags: ['x', 'y'] } },
      'body\n',
    );
    expect(text.startsWith('---\nname: a\ndescription: d\nlicense: MIT\n')).toBe(true);
    const p = parseSkill(text);
    expect(p.frontmatter.extra).toEqual({ license: 'MIT', tags: ['x', 'y'] });
    expect(p.body).toBe('body\n');
  });

  it('validates the name pattern and the description', () => {
    expect(validateFrontmatter({ name: 'ok-name', description: 'x', extra: {} })).toEqual({});
    expect(validateFrontmatter({ name: 'Bad Name', description: ' ', extra: {} })).toEqual({
      name: 'Use lowercase letters, digits and hyphens',
      description: 'Describe when to use this skill',
    });
    expect(SKILL_NAME_PATTERN.test('-leading')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(SKILL_NAME_PATTERN.test('a'.repeat(65))).toBe(false);
  });

  it('flags the files that run code as executable content', () => {
    for (const p of [
      'scripts/run.sh',
      'hooks/pre.json',
      'bin/tool',
      'a/b/setup.py',
      'x.ps1',
      'lib/a.mjs',
    ]) {
      expect(isExecutablePath(p), p).toBe(true);
    }
    for (const p of ['SKILL.md', 'docs/guide.md', 'assets/logo.png', 'description.txt']) {
      expect(isExecutablePath(p), p).toBe(false);
    }
  });
});
