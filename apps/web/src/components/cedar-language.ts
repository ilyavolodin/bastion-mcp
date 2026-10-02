/** A small Monarch grammar for Cedar policies (10.2): enough for keywords, strings and comments. */
type MonacoLike = typeof import('monaco-editor/editor/editor.api');

export const CEDAR_KEYWORDS = [
  'permit',
  'forbid',
  'when',
  'unless',
  'principal',
  'action',
  'resource',
  'context',
  'in',
  'has',
  'like',
  'is',
  'if',
  'then',
  'else',
  'true',
  'false',
];

export const CEDAR_MONARCH: import('monaco-editor/editor/editor.api').languages.IMonarchLanguage = {
  keywords: CEDAR_KEYWORDS,
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/[A-Za-z_][A-Za-z0-9_]*(?=::)/, 'type'],
      [/[A-Za-z_][A-Za-z0-9_]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[0-9]+/, 'number'],
      [/[{}()[\]]/, '@brackets'],
    ],
  },
};

export function registerCedar(monaco: MonacoLike): void {
  monaco.languages.register({ id: 'cedar' });
  monaco.languages.setMonarchTokensProvider('cedar', CEDAR_MONARCH);
  monaco.languages.setLanguageConfiguration('cedar', {
    comments: { lineComment: '//' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  });
}
