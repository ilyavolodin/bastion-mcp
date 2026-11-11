import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { OverrideForm } from '@/features/servers/tabs/override-form';
import { SchemaForm } from '@/features/servers/tabs/schema-form';
import type { JsonSchema } from '@/lib/json-schema-form';

/**
 * The text fields that follow an outside value but never overwrite what is being typed: the override document's
 * JSON fields (12.2) and the Try it form's list and JSON fields (12.5).
 */

type Entry = Record<string, unknown>;

function OverrideHarness({ log }: { log: unknown[] }) {
  const [entry, setEntry] = React.useState<Entry>({ pinnedArguments: { a: 1 } });
  return (
    <>
      <OverrideForm
        kind="tool"
        entry={entry}
        onChange={(field, value) => {
          log.push([field, value]);
          setEntry((e) => {
            const next = { ...e };
            if (value === undefined) delete next[field];
            else next[field] = value;
            return next;
          });
        }}
      />
      <button type="button" onClick={() => setEntry({ pinnedArguments: { z: 9 } })}>
        outside change
      </button>
      <button type="button" onClick={() => setEntry({ pinnedArguments: { a: 1 } })}>
        outside same
      </button>
    </>
  );
}

const pinned = () => screen.getByLabelText('Pinned arguments') as HTMLTextAreaElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('Override JSON field (12.2)', () => {
  it('12.2 starts with the value as indented JSON, an empty field when there is none', () => {
    render(<OverrideHarness log={[]} />);
    expect(pinned().value).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect((screen.getByLabelText('Default arguments') as HTMLTextAreaElement).value).toBe('');
  });

  it('12.2 valid JSON of the expected shape is written; the text stays as typed', () => {
    const log: unknown[] = [];
    render(<OverrideHarness log={log} />);
    type(pinned(), '{"b":   2}');
    expect(log).toEqual([['pinnedArguments', { b: 2 }]]);
    expect(pinned().value).toBe('{"b":   2}');
    expect(pinned()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('12.2 invalid JSON is flagged and not written; fixing it clears the flag', () => {
    const log: unknown[] = [];
    render(<OverrideHarness log={log} />);
    type(pinned(), '{"b":');
    expect(log).toEqual([]);
    expect(pinned()).toHaveAttribute('aria-invalid', 'true');
    expect(pinned().value).toBe('{"b":');
    type(pinned(), '{"b":1}');
    expect(pinned()).not.toHaveAttribute('aria-invalid', 'true');
    expect(log).toEqual([['pinnedArguments', { b: 1 }]]);
  });

  it('12.2 JSON of the wrong shape says what it expected and is not written', () => {
    const log: unknown[] = [];
    render(<OverrideHarness log={log} />);
    type(pinned(), '[1]');
    expect(log).toEqual([]);
    expect(screen.getByText('Expected a JSON object')).toBeInTheDocument();
    type(pinned(), 'null');
    expect(log).toEqual([]);
    type(screen.getByLabelText('Input schema patch'), '{}');
    expect(screen.getByText('Expected a JSON array')).toBeInTheDocument();
    expect(log).toEqual([]);
    type(screen.getByLabelText('Input schema patch'), '[]');
    expect(log).toEqual([['inputSchemaPatch', []]]);
  });

  it('12.2 clearing the text removes the value and the flag', () => {
    const log: unknown[] = [];
    render(<OverrideHarness log={log} />);
    type(pinned(), '{');
    expect(pinned()).toHaveAttribute('aria-invalid', 'true');
    type(pinned(), '   ');
    expect(log).toEqual([['pinnedArguments', undefined]]);
    expect(pinned()).not.toHaveAttribute('aria-invalid', 'true');
    expect(pinned().value).toBe('   ');
  });

  it('12.2 an outside change replaces the text; an outside value equal to the last written one does not', () => {
    render(<OverrideHarness log={[]} />);
    type(pinned(), '{"a":   1}');
    fireEvent.click(screen.getByRole('button', { name: 'outside same' }));
    expect(pinned().value).toBe('{"a":   1}');
    fireEvent.click(screen.getByRole('button', { name: 'outside change' }));
    expect(pinned().value).toBe(JSON.stringify({ z: 9 }, null, 2));
  });

  it('12.2 invalid text survives an outside value that did not change', () => {
    render(<OverrideHarness log={[]} />);
    type(pinned(), '{"a":');
    fireEvent.click(screen.getByRole('button', { name: 'outside same' }));
    expect(pinned().value).toBe('{"a":');
    expect(pinned()).toHaveAttribute('aria-invalid', 'true');
  });
});

const schema: JsonSchema = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
    ids: { type: 'array', items: { type: 'integer' } },
    filter: { type: 'object' },
  },
};

function SchemaHarness({ log }: { log: unknown[] }) {
  const [value, setValue] = React.useState<Entry>({ tags: ['x'], filter: { k: 1 } });
  return (
    <>
      <SchemaForm
        schema={schema}
        value={value}
        onChange={(n) => {
          log.push(n);
          setValue(n);
        }}
      />
      <button type="button" onClick={() => setValue({ tags: ['p', 'q'], filter: { k: 2 } })}>
        outside change
      </button>
      <button type="button" onClick={() => setValue({ tags: ['x'], filter: { k: 1 } })}>
        outside same
      </button>
    </>
  );
}

const box = (name: string) => screen.getByLabelText(name) as HTMLTextAreaElement;

describe('Try it list and JSON fields (12.5)', () => {
  it('12.5 a list shows one item per line and writes the trimmed items; a typed empty line stays', () => {
    const log: unknown[] = [];
    render(<SchemaHarness log={log} />);
    expect(box('tags').value).toBe('x');
    type(box('tags'), 'x\n');
    expect(box('tags').value).toBe('x\n');
    expect(log.at(-1)).toEqual({ tags: ['x'], filter: { k: 1 } });
    type(box('tags'), 'a\n b \n\nc');
    expect(log.at(-1)).toEqual({ tags: ['a', 'b', 'c'], filter: { k: 1 } });
    type(box('ids'), '1\n2');
    expect(log.at(-1)).toMatchObject({ ids: [1, 2] });
    type(box('tags'), '');
    expect(log.at(-1)).toEqual({ ids: [1, 2], filter: { k: 1 } });
  });

  it('12.5 a list follows an outside change, and not an outside value equal to what was written', () => {
    render(<SchemaHarness log={[]} />);
    type(box('tags'), 'x\n');
    fireEvent.click(screen.getByRole('button', { name: 'outside same' }));
    expect(box('tags').value).toBe('x\n');
    fireEvent.click(screen.getByRole('button', { name: 'outside change' }));
    expect(box('tags').value).toBe('p\nq');
  });

  it('12.5 a JSON field writes what parses, flags what does not, and clears on empty text', () => {
    const log: unknown[] = [];
    render(<SchemaHarness log={log} />);
    expect(box('filter').value).toBe(JSON.stringify({ k: 1 }, null, 2));
    type(box('filter'), '[1,');
    expect(box('filter')).toHaveAttribute('aria-invalid', 'true');
    expect(log).toEqual([]);
    type(box('filter'), '[1, 2]');
    expect(box('filter')).not.toHaveAttribute('aria-invalid', 'true');
    expect(log.at(-1)).toEqual({ tags: ['x'], filter: [1, 2] });
    type(box('filter'), '');
    expect(log.at(-1)).toEqual({ tags: ['x'] });
  });

  it('12.5 a JSON field follows an outside change, and keeps typed text for an unchanged value', () => {
    render(<SchemaHarness log={[]} />);
    type(box('filter'), '{"k":   1}');
    fireEvent.click(screen.getByRole('button', { name: 'outside same' }));
    expect(box('filter').value).toBe('{"k":   1}');
    fireEvent.click(screen.getByRole('button', { name: 'outside change' }));
    expect(box('filter').value).toBe(JSON.stringify({ k: 2 }, null, 2));
  });
});
