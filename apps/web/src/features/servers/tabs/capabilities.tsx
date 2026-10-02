import { Layers } from 'lucide-react';
import { useCapabilities } from '@/api/hooks';
import type { ItemKind } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { Card, CardHeader } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { CapabilityLegend, CapabilityRow } from './overview';

const SECTIONS: { kind: ItemKind; label: string }[] = [
  { kind: 'tool', label: 'Tools' },
  { kind: 'prompt', label: 'Prompts' },
  { kind: 'resource', label: 'Resources' },
  { kind: 'template', label: 'Resource templates' },
];

/** Final definitions of tools, prompts, resources and templates, with override, hidden and guard markers. */
export function CapabilitiesTab({ installationId }: { installationId: string }) {
  const q = useCapabilities(installationId);
  return (
    <QueryBoundary
      query={q}
      isEmpty={(d) => d.length === 0}
      empty={<EmptyState icon={<Layers />} title="Nothing to show yet" description="The server has not listed any tools. Restart it from Settings." />}
    >
      {(items) => (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-4">
            <CapabilityLegend />
          </div>
          {SECTIONS.map(({ kind, label }) => {
            const rows = items.filter((i) => i.kind === kind);
            if (rows.length === 0) return null;
            return (
              <Card key={kind} aria-label={label} className="gap-1">
                <CardHeader title={`${label} · ${rows.length}`} className="mb-2" />
                <ul className="m-0 list-none p-0">
                  {rows.map((c) => (
                    <CapabilityRow key={c.name} c={c} />
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </QueryBoundary>
  );
}
