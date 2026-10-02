import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { PluginValidationError } from './errors';

export type ParsedSkill = {
  name: string;
  description: string;
  /** Every frontmatter key, verbatim (including `allowed-tools`, `context`, ...). */
  frontmatter: Record<string, unknown>;
  body: string;
};

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `SKILL.md` in the Agent Skills format (25.2): `name` and `description` are required. */
export const parseSkillMd = (text: string): ParsedSkill => {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new PluginValidationError('SKILL.md has no YAML frontmatter');
  let data: unknown;
  try {
    data = parse(match[1] ?? '');
  } catch (error) {
    throw new PluginValidationError('SKILL.md frontmatter is not valid YAML', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const record = z.record(z.string(), z.unknown()).safeParse(data);
  if (!record.success) throw new PluginValidationError('SKILL.md frontmatter must be a mapping');
  const { name, description } = record.data;
  if (typeof name !== 'string' || name.length === 0 || name.length > 64 || !SKILL_NAME.test(name)) {
    throw new PluginValidationError('frontmatter `name` is required (kebab-case, at most 64 chars)');
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new PluginValidationError('frontmatter `description` is required');
  }
  if (description.length > 1024) {
    throw new PluginValidationError('frontmatter `description` is longer than 1024 chars');
  }
  return { name, description, frontmatter: record.data, body: match[2] ?? '' };
};

/** Writes `SKILL.md` back from the frontmatter form of the editor (25.3). */
export const renderSkillMd = (frontmatter: Record<string, unknown>, body: string): string =>
  `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`;

/** Optional `agents/openai.yaml`: validated as a mapping, every key kept. */
export const parseOpenAiYaml = (text: string): Record<string, unknown> => {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new PluginValidationError('agents/openai.yaml is not valid YAML', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(data ?? {});
  if (!parsed.success) throw new PluginValidationError('agents/openai.yaml must be a mapping');
  return parsed.data;
};
