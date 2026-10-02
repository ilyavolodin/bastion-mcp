import { parse, stringify } from 'yaml';

export type Frontmatter = { name: string; description: string; extra: Record<string, unknown> };
export type ParsedSkill = { frontmatter: Frontmatter; body: string; error: string | null };

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** SKILL.md: YAML frontmatter (`name`, `description` required; other keys kept verbatim, 25.2). */
export function parseSkill(source: string): ParsedSkill {
  const m = FENCE.exec(source);
  if (!m) {
    return {
      frontmatter: { name: '', description: '', extra: {} },
      body: source,
      error: 'SKILL.md must start with a --- frontmatter block',
    };
  }
  try {
    const raw = (parse(m[1] ?? '') ?? {}) as Record<string, unknown>;
    const { name, description, ...extra } = raw;
    return {
      frontmatter: {
        name: typeof name === 'string' ? name : '',
        description: typeof description === 'string' ? description : '',
        extra,
      },
      body: m[2] ?? '',
      error: null,
    };
  } catch (e) {
    return {
      frontmatter: { name: '', description: '', extra: {} },
      body: m[2] ?? '',
      error: e instanceof Error ? e.message : 'Invalid YAML',
    };
  }
}

export function serializeSkill(fm: Frontmatter, body: string): string {
  const yaml = stringify({ name: fm.name, description: fm.description, ...fm.extra }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateFrontmatter(fm: Frontmatter): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  if (!SKILL_NAME_PATTERN.test(fm.name)) out.name = 'Use lowercase letters, digits and hyphens';
  if (fm.description.trim().length === 0) out.description = 'Describe when to use this skill';
  return out;
}

const EXEC_HINT = /(^|\/)(scripts|hooks|bin)\/|\.(sh|bash|zsh|py|js|mjs|ts|ps1|bat)$/;

/** Files that run code on a user's machine are executable content (25.2) and need approval. */
export const isExecutablePath = (path: string): boolean => EXEC_HINT.test(path);
