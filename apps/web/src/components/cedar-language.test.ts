import { describe, expect, it, vi } from 'vitest';
import { CEDAR_KEYWORDS, CEDAR_MONARCH, registerCedar } from './cedar-language';

describe('Cedar language (10.2)', () => {
  it('lists the keywords of the policy language', () => {
    for (const k of ['permit', 'forbid', 'when', 'unless', 'principal', 'action', 'resource']) {
      expect(CEDAR_KEYWORDS).toContain(k);
    }
    expect(CEDAR_MONARCH.keywords).toBe(CEDAR_KEYWORDS);
  });

  it('tokenizes comments, strings, entity types, keywords, identifiers and numbers', () => {
    const rules = CEDAR_MONARCH.tokenizer.root as unknown as [RegExp, unknown][];
    const tokenOf = (text: string) => {
      for (const [re, action] of rules) {
        const m = re.exec(text);
        if (m && m.index === 0) return action;
      }
      return undefined;
    };
    expect(tokenOf('// note')).toBe('comment');
    expect(tokenOf('"a \\" b"')).toBe('string');
    expect(tokenOf('User::"x"')).toBe('type');
    expect(tokenOf('42')).toBe('number');
    expect(tokenOf('permit')).toEqual({
      cases: { '@keywords': 'keyword', '@default': 'identifier' },
    });
  });

  it('registers the language with its tokens and editing rules', () => {
    const monaco = {
      languages: {
        register: vi.fn(),
        setMonarchTokensProvider: vi.fn(),
        setLanguageConfiguration: vi.fn(),
      },
    };
    registerCedar(monaco as never);
    expect(monaco.languages.register).toHaveBeenCalledWith({ id: 'cedar' });
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith('cedar', CEDAR_MONARCH);
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      'cedar',
      expect.objectContaining({ comments: { lineComment: '//' } }),
    );
  });
});
