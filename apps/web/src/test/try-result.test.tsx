import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefinitionPair } from '@/api/views/servers';
import { TryIt } from '@/features/servers/tabs/try-it';

/**
 * Baseline for how Try it shows an answer (12.5): the blocks of every result shape, and the key each item is listed
 * under. The hook is replaced so that any answer can be shown; what is asserted is the rendered panel.
 */

const state = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/api/hooks', () => ({
  useTry: () => ({
    data: state.data,
    isPending: false,
    isError: false,
    error: null,
    mutate: () => {},
    reset: () => {},
  }),
}));

const pair = (
  kind: DefinitionPair['kind'],
  name: string,
  final: Record<string, unknown> | null = {},
): DefinitionPair => ({
  name,
  kind,
  upstream: final,
  final,
  hidden: false,
  added: false,
  error: null,
});

const shown = (kind: DefinitionPair['kind'], result: unknown) => {
  state.data = { result, isError: false, durationMs: 1 };
  render(<TryIt installationId="i-1" defs={[pair(kind, 'one')]} />);
  const group = screen.getByRole('group', { name: 'Result' });
  return Array.from(group.children)
    .filter((el) => el.tagName === 'DIV')
    .map((el) => [el.children[0]?.textContent, el.children[1]?.textContent]);
};

describe('12.5 the blocks Try it shows for an answer', () => {
  it('an error object is named by its code and says its message', () => {
    expect(shown('tool', { error: { code: 'denied', message: 'No.' } })).toEqual([
      ['denied', 'No.'],
    ]);
  });

  it('an error object without code or message is labelled Error and printed as JSON', () => {
    expect(shown('tool', { error: { x: 1 } })).toEqual([['Error', '{"x":1}']]);
  });

  it('an error string is the text of an Error block, and comes before the content', () => {
    expect(shown('tool', { error: 'boom', content: [{ type: 'text', text: 'after' }] })).toEqual([
      ['Error', 'boom'],
      ['Text', 'after'],
    ]);
  });

  it('tool content: text as it is, other typed content as JSON under its type, non-objects skipped, then structured', () => {
    expect(
      shown('tool', {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'abc' },
          { text: 'no type' },
          { type: 'text', text: 5 },
          'plain',
          null,
        ],
        structuredContent: { rows: 2 },
      }),
    ).toEqual([
      ['Text', 'hello'],
      ['image', '{\n  "type": "image",\n  "data": "abc"\n}'],
      ['Content', '{\n  "text": "no type"\n}'],
      ['text', '{\n  "type": "text",\n  "text": 5\n}'],
      ['Structured', '{\n  "rows": 2\n}'],
    ]);
  });

  it('structured content is only shown beside a content list, and null counts as present', () => {
    expect(shown('tool', { structuredContent: { a: 1 } })).toEqual([]);
  });

  it('structured null is printed as null', () => {
    expect(shown('tool', { content: [], structuredContent: null })).toEqual([
      ['Structured', 'null'],
    ]);
  });

  it('prompt messages: role as label, text as it is, else the content as JSON; non-objects skipped', () => {
    expect(
      shown('prompt', {
        messages: [
          { role: 'user', content: { type: 'text', text: 'Hi' } },
          { role: 'assistant', content: { type: 'image' } },
          { content: 'bare' },
          7,
        ],
        content: [{ type: 'text', text: 'ignored for a prompt' }],
      }),
    ).toEqual([
      ['user', 'Hi'],
      ['assistant', '{\n  "type": "image"\n}'],
      ['message', '"bare"'],
    ]);
  });

  it('resource contents: uri and mime type as label, text, blob length, or the entry as JSON', () => {
    expect(
      shown('resource', {
        contents: [
          { uri: 'a://1', mimeType: 'text/plain', text: 'body' },
          { uri: 'a://2', blob: 'QUJD' },
          { mimeType: 'x/y', other: true },
          null,
        ],
      }),
    ).toEqual([
      ['a://1 · text/plain', 'body'],
      ['a://2', '(4 characters of base64 data)'],
      ['resource · x/y', '{\n  "mimeType": "x/y",\n  "other": true\n}'],
    ]);
  });

  it('an answer that is not an object, or of another kind than the one tried, has no blocks but the raw response', () => {
    expect(shown('tool', 'text')).toEqual([]);
    expect(screen.getByText('Raw response')).toBeVisible();
  });

  it('messages of a tool and contents of a prompt are not blocks', () => {
    expect(shown('tool', { messages: [{ role: 'user' }], contents: [{ uri: 'x' }] })).toEqual([]);
  });
});

describe('12.5 the key an item is listed under', () => {
  const picker = (defs: DefinitionPair[]) => {
    state.data = undefined;
    render(<TryIt installationId="i-1" defs={defs} />);
    const select = screen.getByLabelText('Tool');
    return {
      select,
      options: within(select)
        .getAllByRole('option')
        .map((o) => [(o as HTMLOptionElement).value, o.textContent]),
    };
  };

  it('a tool is listed under the name AI tools use: the override’s name', () => {
    const { select, options } = picker([
      pair('tool', 'upstream_a', { name: 'renamed_a' }),
      pair('tool', 'b', {}),
      pair('tool', 'hidden', null),
    ]);
    expect(options).toEqual([
      ['renamed_a', 'renamed_a'],
      ['b', 'b'],
    ]);
    expect(select).toHaveValue('renamed_a');
  });
});
