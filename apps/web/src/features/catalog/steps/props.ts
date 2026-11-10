import type { Draft, SpecDraft } from '../draft';

/** What every editor section of a step gets: the draft, how to change it, and whether it may be edited. */
export type EditorProps = {
  draft: Draft;
  onChange: (d: Draft) => void;
  readOnly?: boolean | undefined;
};

/** What a whole step of the editor gets. */
export type StepProps = EditorProps & {
  /** Server-side field errors of the last save, keyed by field (`slug`, `label`...). */
  errors?: Record<string, string>;
  /** Whether the entry already exists: its URL name, owner and kind cannot change then. */
  existing?: boolean;
};

/** The draft with a patch applied to its server spec. */
export const setSpec = (d: Draft, patch: Partial<SpecDraft>): Draft => ({
  ...d,
  spec: { ...d.spec, ...patch },
});

type ListKey = 'variables' | 'headers' | 'envVars' | 'args';

/** The edit and remove callbacks of row `i` of one of the spec's row lists. */
export const rowHandlers = <K extends ListKey>(
  draft: Draft,
  onChange: (d: Draft) => void,
  key: K,
  i: number,
) => {
  const rows: SpecDraft[K] = draft.spec[key];
  return {
    onChange: (next: SpecDraft[K][number]) =>
      onChange(setSpec(draft, { [key]: rows.map((r, k) => (k === i ? next : r)) })),
    onRemove: () => onChange(setSpec(draft, { [key]: rows.filter((_, k) => k !== i) })),
  };
};
