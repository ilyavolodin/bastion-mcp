/**
 * Monaco, wired for offline use (no CDN): the editor core plus the few contributions the JSON and Cedar
 * editors need, with local workers. Loaded lazily by `code-editor.tsx`, so it never reaches the
 * first-paint bundle.
 */
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import { useEffect } from 'react';
import { registerCedar } from './cedar-language';
import type { CodeEditorProps } from './code-editor';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};
loader.config({ monaco });
registerCedar(monaco);

const THEME = { light: 'bastion-light', dark: 'bastion-dark' } as const;
let themesDefined = false;
const defineThemes = () => {
  if (themesDefined) return;
  themesDefined = true;
  monaco.editor.defineTheme(THEME.light, {
    base: 'vs',
    inherit: true,
    rules: [{ token: 'keyword', foreground: 'b24700', fontStyle: 'bold' }],
    colors: { 'editor.background': '#ffffff', 'editor.foreground': '#171a3a' },
  });
  monaco.editor.defineTheme(THEME.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: 'keyword', foreground: 'ffa855', fontStyle: 'bold' }],
    colors: { 'editor.background': '#1c1c20', 'editor.foreground': '#f4f4f6' },
  });
};

export default function MonacoImpl({
  value,
  onChange,
  language,
  height = 320,
  ariaLabel,
  readOnly,
  jsonSchema,
  markers,
}: CodeEditorProps) {
  const dark = document.documentElement.dataset.theme === 'dark';
  defineThemes();

  useEffect(() => {
    if (language !== 'json') return;
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      schemas: jsonSchema
        ? [{ uri: 'inmemory://bastion/schema.json', fileMatch: ['*'], schema: jsonSchema }]
        : [],
    });
  }, [language, jsonSchema]);

  return (
    <Editor
      height={height}
      language={language}
      value={value}
      theme={dark ? THEME.dark : THEME.light}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={(editor) => {
        const model = editor.getModel();
        if (model && markers) monaco.editor.setModelMarkers(model, 'bastion', markers.map((m) => ({
          startLineNumber: m.line,
          endLineNumber: m.line,
          startColumn: 1,
          endColumn: 200,
          message: m.message,
          severity: monaco.MarkerSeverity.Error,
        })));
        editor.getDomNode()?.setAttribute('aria-label', ariaLabel);
      }}
      options={{
        readOnly: readOnly ?? false,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        accessibilitySupport: 'on',
        ariaLabel,
      }}
    />
  );
}
