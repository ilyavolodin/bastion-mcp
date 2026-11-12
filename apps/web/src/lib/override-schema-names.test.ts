import { describe, expect, it } from 'vitest';
import { validateOverrideText } from './override-schema';

const issuesOf = (doc: unknown) => {
  const r = validateOverrideText(JSON.stringify(doc));
  return r.ok ? [] : r.issues;
};

const NAME_MESSAGE = 'must match ^[A-Za-z0-9_.-]{1,128}$';

describe('override name rules (12.2)', () => {
  it('12.2 a tool name outside the name pattern says which pattern', () => {
    expect(issuesOf({ tools: { t: { name: 'bad name!' } } })).toEqual([
      { path: 'tools.t.name', message: NAME_MESSAGE },
    ]);
  });

  it('12.2 a hosted prompt key outside the name pattern says which pattern', () => {
    expect(
      issuesOf({ added: { prompts: { 'bad name': { messages: [{ role: 'user', text: 'x' }] } } } }),
    ).toEqual([{ path: 'added.prompts.bad name', message: NAME_MESSAGE }]);
  });

  it('12.2 a hosted prompt argument name outside the name pattern says which pattern', () => {
    expect(
      issuesOf({
        added: {
          prompts: {
            p: { arguments: [{ name: 'no good' }], messages: [{ role: 'user', text: 'x' }] },
          },
        },
      }),
    ).toEqual([{ path: 'added.prompts.p.arguments.0.name', message: NAME_MESSAGE }]);
  });

  it('12.2 the pattern accepts letters, digits, underscore, dot and dash up to 128 characters', () => {
    expect(issuesOf({ tools: { t: { name: 'a'.repeat(128) } } })).toEqual([]);
    expect(issuesOf({ tools: { t: { name: 'a'.repeat(129) } } })).toHaveLength(1);
    expect(issuesOf({ tools: { t: { name: 'A_b.c-9' } } })).toEqual([]);
    expect(issuesOf({ tools: { t: { name: '' } } })).toHaveLength(1);
  });
});
