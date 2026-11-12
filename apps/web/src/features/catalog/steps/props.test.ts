import { describe, expect, it } from 'vitest';
import { type Draft, emptyDraft } from '../draft';
import { rowHandlers } from './props';

const draftWith = () => {
  const d = emptyDraft();
  return {
    ...d,
    spec: {
      ...d.spec,
      headers: [
        { name: 'A', value: '1', secret: false },
        { name: 'B', value: '2', secret: false },
        { name: 'C', value: '3', secret: true },
      ],
    },
  };
};

describe('rowHandlers', () => {
  it('onChange replaces row i and keeps the other rows by identity', () => {
    const draft = draftWith();
    let out = draft;
    const { onChange } = rowHandlers(draft, (d) => (out = d), 'headers', 1);
    const next = { name: 'B', value: 'new', secret: true };
    onChange(next);
    expect(out.spec.headers).toEqual([draft.spec.headers[0], next, draft.spec.headers[2]]);
    expect(out.spec.headers[0]).toBe(draft.spec.headers[0]);
    expect(out.spec.headers[2]).toBe(draft.spec.headers[2]);
    expect(out.spec.envVars).toBe(draft.spec.envVars);
  });

  it('onRemove drops row i only', () => {
    const draft = draftWith();
    let out = draft;
    rowHandlers(draft, (d) => (out = d), 'headers', 0).onRemove();
    expect(out.spec.headers).toEqual([draft.spec.headers[1], draft.spec.headers[2]]);
    expect(draft.spec.headers).toHaveLength(3);
  });

  it('works for the other lists', () => {
    const d = emptyDraft();
    const draft = {
      ...d,
      spec: {
        ...d.spec,
        args: [{ kind: 'positional' as const, name: '', value: 'x', secret: false }],
      },
    };
    let out: Draft = draft;
    rowHandlers(draft, (n) => (out = n), 'args', 0).onRemove();
    expect(out.spec.args).toEqual([]);
  });
});
