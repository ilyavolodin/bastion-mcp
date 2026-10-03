import * as React from 'react';
import { CodeEditor } from '@/components/code-editor';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { Select } from '@/components/ui/input';
import { overrideJsonSchema, validateOverrideText } from '@/lib/override-schema';
import type { UserOverrides } from '../draft';
import type { StepProps } from './props';

export function OverridesStep({ draft, onChange, readOnly }: StepProps) {
  const [text, setText] = React.useState(() => JSON.stringify(draft.overrides, null, 2));
  const v = validateOverrideText(text);
  const schema = React.useMemo(() => overrideJsonSchema(), []);
  const empty = v.ok && Object.keys(v.document).every((k) => k === 'version');
  return (
    <Card aria-label="Overrides" className="gap-4">
      <CardHeader
        title="Overrides"
        subtitle="The default overrides every installation starts from"
      />
      <CodeEditor
        language="json"
        ariaLabel="Default override document"
        height={280}
        value={text}
        readOnly={readOnly ?? false}
        jsonSchema={schema}
        onChange={(t) => {
          setText(t);
          const r = validateOverrideText(t);
          // The draft keeps the last valid document; the error blocks Save (not Back and Next), so a typo
          // is never saved silently and never traps the author on this step.
          onChange(
            r.ok
              ? { ...draft, overrides: r.document, overridesError: undefined }
              : {
                  ...draft,
                  overridesError: r.issues
                    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
                    .join('; '),
                },
          );
        }}
      />
      {v.ok ? (
        <p className="m-0 text-caption font-medium text-mint-ink">
          {empty
            ? 'Valid. Empty: installations start with no overrides. {} and {"version": 1} are the same.'
            : 'Valid override document.'}
        </p>
      ) : (
        <ul
          role="alert"
          className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
        >
          {v.issues.map((i) => (
            <li key={`${i.path}${i.message}`}>
              {i.path ? `${i.path}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <Field label="What may people override on their installs?">
        {({ id }) => (
          <Select
            id={id}
            disabled={readOnly}
            value={draft.userOverrides}
            onChange={(e) => onChange({ ...draft, userOverrides: e.target.value as UserOverrides })}
          >
            <option value="none">Nothing</option>
            <option value="cosmetic">Cosmetic: hide, rename, title, description</option>
            <option value="full">Full: also arguments and schema</option>
          </Select>
        )}
      </Field>
    </Card>
  );
}
