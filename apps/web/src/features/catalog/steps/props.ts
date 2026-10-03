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
