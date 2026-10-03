/**
 * The form for the prompts, resources and resource templates Bastion hosts itself (12.2 `added`): pure conversions
 * between what a person types and the definition stored in the override document.
 */
import type { AddedSection } from './override-schema';

export type AddedKind = 'prompt' | 'resource' | 'template';

export type AddedDraft = {
  kind: AddedKind;
  /** Prompt name, resource URI or URI template: the key in the document. */
  key: string;
  /** A resource's or template's own name. */
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** A resource's or template's text. */
  text: string;
  /** One prompt argument per line: `repo`, `repo*` when required, `repo*: what it is` with a description. */
  args: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
};

export const sectionOfAdded = (kind: AddedKind): AddedSection =>
  kind === 'prompt' ? 'prompts' : kind === 'resource' ? 'resources' : 'resourceTemplates';

export const emptyDraft = (kind: AddedKind): AddedDraft => ({
  kind,
  key: '',
  name: '',
  title: '',
  description: '',
  mimeType: '',
  text: '',
  args: '',
  messages: [{ role: 'user', text: '' }],
});

type Arg = { name: string; description?: string; required?: boolean };

export const parseArgs = (text: string): Arg[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const colon = line.indexOf(':');
      const head = (colon === -1 ? line : line.slice(0, colon)).trim();
      const description = colon === -1 ? '' : line.slice(colon + 1).trim();
      const required = head.endsWith('*');
      const name = required ? head.slice(0, -1).trim() : head;
      return {
        name,
        ...(description === '' ? {} : { description }),
        ...(required ? { required: true } : {}),
      };
    });

export const formatArgs = (args: readonly Arg[] | undefined): string =>
  (args ?? [])
    .map((a) => `${a.name}${a.required ? '*' : ''}${a.description ? `: ${a.description}` : ''}`)
    .join('\n');

const optional = (value: string): string | undefined => (value.trim() === '' ? undefined : value);

/** The definition as stored; empty optional fields are left out. */
export const draftToDefinition = (draft: AddedDraft): Record<string, unknown> => {
  const common = {
    ...(optional(draft.title) === undefined ? {} : { title: draft.title }),
    ...(optional(draft.description) === undefined ? {} : { description: draft.description }),
  };
  if (draft.kind === 'prompt') {
    const args = parseArgs(draft.args);
    return {
      ...common,
      ...(args.length === 0 ? {} : { arguments: args }),
      messages: draft.messages.map((m) => ({ role: m.role, text: m.text })),
    };
  }
  return {
    name: draft.name,
    ...common,
    ...(optional(draft.mimeType) === undefined ? {} : { mimeType: draft.mimeType.trim() }),
    text: draft.text,
  };
};

type Stored = {
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  text?: string;
  arguments?: Arg[];
  messages?: { role: 'user' | 'assistant'; text: string }[];
};

export const definitionToDraft = (
  kind: AddedKind,
  key: string,
  definition: Record<string, unknown>,
): AddedDraft => {
  const d = definition as Stored;
  return {
    kind,
    key,
    name: d.name ?? '',
    title: d.title ?? '',
    description: d.description ?? '',
    mimeType: d.mimeType ?? '',
    text: d.text ?? '',
    args: formatArgs(d.arguments),
    messages: d.messages?.length ? d.messages : [{ role: 'user', text: '' }],
  };
};

/** `{{name}}` placeholders in the text that the prompt does not declare as arguments (they would be sent as written). */
export const undeclaredPlaceholders = (draft: AddedDraft): string[] => {
  const declared =
    draft.kind === 'prompt'
      ? new Set(parseArgs(draft.args).map((a) => a.name))
      : new Set(
          [...draft.key.matchAll(/\{[+#./;?&]?([^{}]+)\}/g)].flatMap((m) =>
            (m[1] ?? '').split(',').map((v) => v.replace(/(:\d+|\*)$/, '').trim()),
          ),
        );
  const texts = draft.kind === 'prompt' ? draft.messages.map((m) => m.text) : [draft.text];
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
      if (!declared.has(m[1] as string)) found.add(m[1] as string);
    }
  }
  return [...found];
};
