import * as React from 'react';
import type { DefinitionPair } from '@/api/views/servers';
import { DiffView } from '@/components/diff-view';
import { Segmented, Tag } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { stableStringify } from '@/lib/diff';
import { type OverrideDocument, sectionOf, setItemField } from '@/lib/override-schema';
import { OverrideForm } from './override-form';

type KindFilter = 'all' | DefinitionPair['kind'];

const KIND_LABEL: Record<DefinitionPair['kind'], string> = {
  tool: 'Tool',
  prompt: 'Prompt',
  resource: 'Resource',
  template: 'Template',
};

const entryOf = (doc: OverrideDocument, d: DefinitionPair): Record<string, unknown> =>
  doc[sectionOf(d.kind)]?.[d.name] ?? {};

/** Fields other than `hidden`: what makes an item "customized" rather than merely hidden. */
const customizedFields = (entry: Record<string, unknown>) =>
  Object.keys(entry).filter((k) => k !== 'hidden');

const describe = (d: DefinitionPair): string => {
  const def = d.final ?? d.upstream;
  const text = def && typeof def.description === 'string' ? def.description : '';
  return text.split('\n')[0] ?? '';
};

/**
 * What AI tools see, one row per item: a switch for whether it is shown at all (the common job), and a "Customize"
 * panel with the definition diff and every other override field for the few items that need more.
 */
export function ItemsList({
  defs,
  doc,
  canEdit,
  onChange,
}: {
  defs: DefinitionPair[];
  doc: OverrideDocument;
  canEdit: boolean;
  /** Called with the document after the change; the caller keeps the raw JSON in step. */
  onChange: (next: OverrideDocument) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState<KindFilter>('all');
  const [open, setOpen] = React.useState<string | null>(null);

  const kinds = React.useMemo(() => [...new Set(defs.map((d) => d.kind))], [defs]);
  const q = query.trim().toLowerCase();
  const visible = defs.filter(
    (d) =>
      (kind === 'all' || d.kind === kind) &&
      (q === '' || d.name.toLowerCase().includes(q) || describe(d).toLowerCase().includes(q)),
  );

  const setHidden = (list: DefinitionPair[], hidden: boolean) => {
    let next = doc;
    for (const d of list) {
      next = setItemField(next, sectionOf(d.kind), d.name, 'hidden', hidden ? true : undefined);
    }
    onChange(next);
  };

  if (defs.length === 0) {
    return <p className="m-0 text-muted">Waiting for the server’s definitions…</p>;
  }

  const hiddenCount = defs.filter((d) => entryOf(doc, d).hidden === true).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search items"
          placeholder="Search by name or description"
          className="max-w-72"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {kinds.length > 1 ? (
          <Segmented
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'All' },
              ...kinds.map((k) => ({ value: k, label: `${KIND_LABEL[k]}s` })),
            ]}
          />
        ) : null}
        <span className="flex-1" />
        <span className="text-caption text-muted">
          {defs.length - hiddenCount} of {defs.length} shown
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!canEdit || visible.length === 0}
          onClick={() => setHidden(visible, false)}
        >
          Show these
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canEdit || visible.length === 0}
          onClick={() => setHidden(visible, true)}
        >
          Hide these
        </Button>
      </div>
      {visible.length === 0 ? <p className="m-0 text-muted">Nothing matches.</p> : null}
      <ul aria-label="Items" className="m-0 flex list-none flex-col gap-2 p-0">
        {visible.map((d) => {
          const key = `${d.kind}-${d.name}`;
          const entry = entryOf(doc, d);
          const hidden = entry.hidden === true;
          const custom = customizedFields(entry).length;
          const expanded = open === key;
          return (
            <li key={key} className="rounded-md border border-line bg-surface">
              <div className="flex items-center gap-3 p-3">
                <Switch
                  aria-label={`Show ${d.name}`}
                  disabled={!canEdit}
                  checked={!hidden}
                  onCheckedChange={(shown) => setHidden([d], !shown)}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[13px]">{d.name}</span>
                  <span className="truncate text-caption text-muted">{describe(d)}</span>
                </div>
                {d.kind !== 'tool' ? <Tag>{KIND_LABEL[d.kind]}</Tag> : null}
                {hidden ? <Tag tone="warn">Hidden</Tag> : null}
                {custom > 0 ? <Tag tone="info">Customized</Tag> : null}
                {d.error ? <Tag tone="bad">Not served</Tag> : null}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : key)}
                >
                  {expanded ? 'Close' : 'Customize'}
                </Button>
              </div>
              {expanded ? (
                <div className="flex flex-col gap-5 border-t border-line p-4">
                  {d.error ? <p className="m-0 text-muted">Not served: {d.error}</p> : null}
                  <DiffView
                    mode="lines"
                    leftLabel="Upstream definition"
                    rightLabel="Final definition"
                    left={
                      d.upstream
                        ? stableStringify(d.upstream)
                        : '(the definition is withheld while the item is hidden)'
                    }
                    right={d.final ? stableStringify(d.final) : '(hidden)'}
                  />
                  <OverrideForm
                    kind={d.kind}
                    entry={entry}
                    disabled={!canEdit}
                    onChange={(field, value) =>
                      onChange(setItemField(doc, sectionOf(d.kind), d.name, field, value))
                    }
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
