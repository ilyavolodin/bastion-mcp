import { Link } from '@tanstack/react-router';
import { Layers, Plus } from 'lucide-react';
import { z } from 'zod';
import { useCatalog } from '@/api/hooks';
import type { CatalogStatus } from '@/api/schema';
import type { CatalogEntryView } from '@/api/views/catalog';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ServerIcon, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import { useSearchState } from '@/lib/search';
import { AutoInstallPanel } from './auto-install';

const searchSchema = z.object({
  tab: z.enum(['entries', 'policies']).catch('entries').default('entries'),
  kind: z.enum(['all', 'mcp_server', 'plugins']).catch('all').default('all'),
});

const STATUS: Record<CatalogStatus, { tone: 'ok' | 'warn' | 'neutral' | 'bad'; label: string }> = {
  published: { tone: 'ok', label: 'Published' },
  draft: { tone: 'warn', label: 'Draft' },
  deprecated: { tone: 'neutral', label: 'Deprecated' },
  archived: { tone: 'bad', label: 'Archived' },
};

export const editorPath = (e: Pick<CatalogEntryView, 'id' | 'kind'>) =>
  e.kind === 'mcp_server' ? `/catalog/${e.id}` : `/plugins/edit/${e.id}`;

function EntryRow({ e }: { e: CatalogEntryView }) {
  const s = STATUS[e.status];
  return (
    <li className="flex items-center gap-3.5 border-b border-line py-3 last:border-b-0">
      <ServerIcon letter={e.letter} color={e.color} size={36} />
      <div className="min-w-0 flex-1">
        <Link
          to={editorPath(e)}
          className="text-[15px] font-semibold text-ink no-underline hover:underline"
        >
          {e.displayName}
        </Link>
        <div className="truncate text-caption text-muted">{e.description || '—'}</div>
      </div>
      <Tag>{e.kind === 'mcp_server' ? 'Server' : e.kind === 'plugin' ? 'Plugin' : 'Skill'}</Tag>
      <Tag tone={s.tone}>{s.label}</Tag>
      <span className="w-20 text-right text-caption text-muted max-md:hidden">
        {e.currentVersion
          ? `v${e.currentVersion}`
          : e.currentVersionId
            ? 'published'
            : 'unpublished'}
      </span>
      <span className="w-28 text-right text-caption text-muted max-lg:hidden">
        {e.ownerTeamName ?? 'Org'} · {formatRelative(e.updatedAt)}
      </span>
    </li>
  );
}

export function CatalogPage() {
  const [s, setS] = useSearchState(searchSchema);
  const q = useCatalog();
  return (
    <>
      <PageHeader
        title="Catalog"
        subtitle="Author, test and publish entries, then decide who gets them."
        actions={
          <Button asChild>
            <Link to="/catalog/$id" params={{ id: 'new' }}>
              <Plus className="size-4" aria-hidden="true" />
              New entry
            </Link>
          </Button>
        }
      />
      <Tabs value={s.tab} onValueChange={(v) => setS({ tab: v as 'entries' | 'policies' })}>
        <TabsList aria-label="Catalog sections">
          <TabsTrigger value="entries">Entries</TabsTrigger>
          <TabsTrigger value="policies">Auto-install policies</TabsTrigger>
        </TabsList>
        <TabsContent value="entries">
          <div className="mb-4 flex gap-2" role="group" aria-label="Kind">
            {(
              [
                ['all', 'All'],
                ['mcp_server', 'Servers'],
                ['plugins', 'Skills and plugins'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={s.kind === v}
                onClick={() => setS({ kind: v })}
                className={`h-9 rounded-full px-3.5 text-[13px] font-medium ${s.kind === v ? 'bg-ink text-canvas' : 'border border-line bg-surface'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <QueryBoundary
            query={q}
            isEmpty={(d) => d.length === 0}
            empty={
              <EmptyState
                icon={<Layers />}
                title="Nothing in the catalog yet"
                description="Create the first entry, test it, and publish it to the Store."
                action={{ label: 'New entry', to: '/catalog/new' }}
              />
            }
          >
            {(items) => (
              <ul className="m-0 list-none rounded-lg bg-surface px-5 py-2 shadow-card">
                {items
                  .filter(
                    (e) =>
                      s.kind === 'all' ||
                      (s.kind === 'mcp_server' ? e.kind === 'mcp_server' : e.kind !== 'mcp_server'),
                  )
                  .map((e) => (
                    <EntryRow key={e.id} e={e} />
                  ))}
              </ul>
            )}
          </QueryBoundary>
        </TabsContent>
        <TabsContent value="policies">
          <AutoInstallPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}
