import * as React from 'react';
import { Field } from '@/components/form';
import { Segmented } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import {
  type AddedDraft,
  type AddedKind,
  draftToDefinition,
  emptyDraft,
  sectionOfAdded,
  undeclaredPlaceholders,
} from '@/lib/added-items';
import { type OverrideDocument, setAddedItem, validateOverrideText } from '@/lib/override-schema';

const KEY_LABEL: Record<AddedKind, { label: string; help: string; placeholder: string }> = {
  prompt: {
    label: 'Prompt name',
    help: 'Letters, digits, _ . - (up to 128)',
    placeholder: 'review_change',
  },
  resource: {
    label: 'Resource URI',
    help: 'Any URI with a scheme, such as notes://welcome',
    placeholder: 'notes://welcome',
  },
  template: {
    label: 'URI template',
    help: 'A URI with {variables}, such as notes://page/{id}',
    placeholder: 'notes://page/{id}',
  },
};

/**
 * Adds or edits a prompt, resource or resource template that Bastion serves itself (12.2 `added`): fixed text, with
 * `{{name}}` filled in from a prompt's arguments or a template's variables. The stored document is validated here
 * with the same rules the server applies.
 */
export function AddedForm({
  doc,
  editing,
  onSave,
  onCancel,
}: {
  doc: OverrideDocument;
  /** The item being edited: its kind and key cannot change. */
  editing: AddedDraft | null;
  onSave: (next: OverrideDocument) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<AddedDraft>(editing ?? emptyDraft('prompt'));
  const [error, setError] = React.useState<string | undefined>();
  const set = <K extends keyof AddedDraft>(field: K, value: AddedDraft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));
  const isPrompt = draft.kind === 'prompt';
  const copy = KEY_LABEL[draft.kind];
  const unknown = undeclaredPlaceholders(draft);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const section = sectionOfAdded(draft.kind);
    const key = draft.key.trim();
    if (key === '') return setError(`${copy.label} is required`);
    if (!editing && doc.added?.[section]?.[key]) {
      return setError(
        `There is already a ${draft.kind === 'template' ? 'template' : draft.kind} named ${key}`,
      );
    }
    if (!isPrompt && draft.name.trim() === '') return setError('Name is required');
    const next = setAddedItem(doc, section, key, draftToDefinition({ ...draft, key }));
    const checked = validateOverrideText(JSON.stringify(next));
    if (!checked.ok) {
      const first = checked.issues[0];
      return setError(first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid');
    }
    onSave(next);
  };

  return (
    <form
      aria-label="Add item"
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-md border border-line bg-sunken p-4"
    >
      {editing ? null : (
        <Segmented
          label="Kind of item"
          value={draft.kind}
          onChange={(kind) => setDraft({ ...emptyDraft(kind), kind })}
          options={[
            { value: 'prompt', label: 'Prompt' },
            { value: 'resource', label: 'Resource' },
            { value: 'template', label: 'Resource template' },
          ]}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={copy.label} help={copy.help} required>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              disabled={Boolean(editing)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={copy.placeholder}
              value={draft.key}
              onChange={(e) => set('key', e.target.value)}
            />
          )}
        </Field>
        {isPrompt ? null : (
          <Field label="Name" required>
            {({ id }) => (
              <Input
                id={id}
                autoComplete="off"
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label="Title">
          {({ id }) => (
            <Input id={id} value={draft.title} onChange={(e) => set('title', e.target.value)} />
          )}
        </Field>
        <Field label="Description" help="What AI tools read to decide when to use it">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>
        {isPrompt ? null : (
          <Field label="Mime type" help="Defaults to text/plain">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                placeholder="text/markdown"
                value={draft.mimeType}
                onChange={(e) => set('mimeType', e.target.value)}
              />
            )}
          </Field>
        )}
      </div>
      {isPrompt ? (
        <>
          <Field
            label="Arguments"
            help="One per line: name, name* when required, name*: what it is. Use {{name}} in the messages."
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                spellCheck={false}
                className="min-h-16 font-mono text-[12px]"
                value={draft.args}
                onChange={(e) => set('args', e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-col gap-3">
            {draft.messages.map((m, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)_auto]">
                <Select
                  aria-label={`Message ${i + 1} role`}
                  value={m.role}
                  onChange={(e) =>
                    set(
                      'messages',
                      draft.messages.map((x, j) =>
                        j === i ? { ...x, role: e.target.value as 'user' | 'assistant' } : x,
                      ),
                    )
                  }
                >
                  <option value="user">User</option>
                  <option value="assistant">Assistant</option>
                </Select>
                <Textarea
                  aria-label={`Message ${i + 1}`}
                  className="min-h-16"
                  value={m.text}
                  onChange={(e) =>
                    set(
                      'messages',
                      draft.messages.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={draft.messages.length === 1}
                  onClick={() =>
                    set(
                      'messages',
                      draft.messages.filter((_, j) => j !== i),
                    )
                  }
                >
                  Remove message
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  set('messages', [
                    ...draft.messages,
                    {
                      role: draft.messages.at(-1)?.role === 'user' ? 'assistant' : 'user',
                      text: '',
                    },
                  ])
                }
              >
                Add message
              </Button>
            </div>
          </div>
        </>
      ) : (
        <Field
          label="Text"
          help={
            draft.kind === 'template'
              ? 'What is served. {{variable}} is replaced by the matching part of the URI.'
              : 'What is served.'
          }
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              spellCheck={false}
              className="min-h-32 font-mono text-[12px]"
              value={draft.text}
              onChange={(e) => set('text', e.target.value)}
            />
          )}
        </Field>
      )}
      {unknown.length > 0 ? (
        <p className="m-0 text-caption text-muted">
          {unknown.map((n) => `{{${n}}}`).join(', ')}{' '}
          {isPrompt ? 'is not one of the arguments' : 'is not a variable of the template'} and will
          be served as written.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          {editing ? 'Update item' : 'Add item'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
