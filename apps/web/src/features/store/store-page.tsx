import { Link } from '@tanstack/react-router';
import { Check, Plus, Search, ShieldCheck, Store } from 'lucide-react';
import * as React from 'react';
import { z } from 'zod';
import { useStore, useStoreEntry } from '@/api/hooks';
import type { StoreEntry } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ServerIcon, Tag } from '@/components/primitives';
import { CardsSkeleton, QueryBoundary } from '@/components/query-boundary';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/cn';
import { AUTH_LABEL, formatNumber, ISOLATION_LABEL, RUNTIME_LABEL } from '@/lib/format';
import { useSearchState } from '@/lib/search';
import { EntryDetail } from './entry-detail';
import { InstallFlow } from './install-flow';

const searchSchema = z.object({
  q: z.coerce.string().optional(),
  c: z.coerce.string().optional(),
  entry: z.coerce.string().optional(),
});

const AUTH_TONE = { oauth: 'warn', userSecret: 'berry', teamSecret: 'ok', none: 'ok' } as const;

function StoreCard({ entry, selected, onSelect }: { entry: StoreEntry; selected: boolean; onSelect: () => void }) {
  return (
    <article
      className={cn(
        'relative flex flex-col gap-3 rounded-lg bg-surface p-[18px] shadow-card',
        selected && 'ring-2 ring-tangerine-ink',
      )}
    >
      <div className="flex items-start gap-3">
        <ServerIcon letter={entry.letter} color={entry.color} />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[15px] leading-[22px] font-semibold">
            {/* The whole card is the target; the button keeps it keyboard reachable. */}
            <button
              type="button"
              onClick={onSelect}
              aria-expanded={selected}
              className="text-left after:absolute after:inset-0 after:rounded-lg after:content-['']"
            >
              {entry.displayName}
            </button>
          </h3>
          <p className="m-0 mt-0.5 text-caption text-muted">{entry.description}</p>
        </div>
        {entry.installed ? (
          <Tag tone="ok" icon={<Check className="size-3" strokeWidth={2.25} aria-hidden="true" />}>
            Installed
          </Tag>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Tag>{RUNTIME_LABEL[entry.runtime]}</Tag>
        <Tag tone={AUTH_TONE[entry.authMode]}>{AUTH_LABEL[entry.authMode]}</Tag>
        {entry.isolation !== 'none' ? (
          <Tag tone="info" icon={<ShieldCheck className="size-[11px]" aria-hidden="true" />}>
            {ISOLATION_LABEL[entry.isolation]}
          </Tag>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-sunken" aria-hidden="true">
          <div className="h-full rounded-sm" style={{ width: `${entry.popularity}%`, background: entry.color }} />
        </div>
        <span className="text-caption text-muted">{formatNumber(entry.installCount)} people</span>
      </div>
    </article>
  );
}

export function StorePage() {
  const { can } = useAuth();
  const [search, setSearch] = useSearchState(searchSchema);
  const [draft, setDraft] = React.useState(search.q ?? '');
  const [installing, setInstalling] = React.useState(false);
  const wide = useMediaQuery('(min-width: 1280px)');
  const store = useStore(search.q ?? '');
  const detail = useStoreEntry(search.entry ?? null);

  // Debounce typing into the URL so the list refetches once per pause.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== (search.q ?? '')) setSearch({ q: draft || undefined });
    }, 250);
    return () => clearTimeout(t);
  }, [draft, search.q, setSearch]);

  const categories = React.useMemo(
    () => ['All', ...Array.from(new Set((store.data ?? []).map((e) => e.category))).sort()],
    [store.data],
  );
  const category = search.c ?? 'All';
  const entry = detail.data;
  const close = () => setSearch({ entry: undefined });

  return (
    <>
      <PageHeader
        title="Store"
        subtitle="Servers your admins have approved. Install one and it joins your endpoint."
        actions={
          <RoleGate roles={['admin', 'manager']}>
            <Button asChild variant="outline">
              <Link to="/catalog/$id" params={{ id: 'new' }}>
                <Plus className="size-4" aria-hidden="true" />
                New catalog entry
              </Link>
            </Button>
          </RoleGate>
        }
      />

      <div role="tablist" aria-label="Store sections" className="flex items-center gap-1 self-start rounded-md bg-line p-1">
        <span role="tab" aria-selected="true" tabIndex={0} className="inline-flex h-9 items-center rounded-sm bg-grad-tangerine px-4 text-label text-on-bright">
          Approved servers
        </span>
        {can('registry') ? (
          <Link to="/registry" role="tab" aria-selected="false" className="inline-flex h-9 items-center gap-2 rounded-sm px-4 text-label text-muted no-underline hover:text-ink">
            MCP Registry
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-12 min-w-[260px] flex-[1_1_360px] items-center gap-2.5 rounded-md bg-surface px-4 shadow-card">
          <Search className="size-[18px] text-muted" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search the store"
            placeholder="Search by name, tool or what you want to do"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
        </div>
        <div role="group" aria-label="Categories" className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={c === category}
              onClick={() => setSearch({ c: c === 'All' ? undefined : c })}
              className={cn(
                'h-9 rounded-full px-3.5 text-[13px] font-medium',
                c === category ? 'bg-ink text-canvas' : 'border border-line bg-surface text-ink',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <QueryBoundary
            query={store}
            label="Loading the store"
            skeleton={<CardsSkeleton count={6} className="h-[150px]" />}
            isEmpty={(d) => d.length === 0}
            empty={
              <EmptyState
                icon={<Store />}
                title={search.q ? `Nothing matches “${search.q}”` : 'The store is empty'}
                description={
                  search.q
                    ? 'Try a tool name or what you want to do, like “create ticket”.'
                    : 'An admin or manager publishes the first server from the Catalog.'
                }
                action={search.q ? { label: 'Clear search', onClick: () => { setDraft(''); setSearch({ q: undefined }); } } : undefined}
              />
            }
          >
            {(items) => {
              const shown = items.filter((e) => category === 'All' || e.category === category);
              return shown.length === 0 ? (
                <EmptyState
                  icon={<Store />}
                  title={`No ${category} servers yet`}
                  action={{ label: 'Show all', onClick: () => setSearch({ c: undefined }) }}
                />
              ) : (
                <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
                  {shown.map((e) => (
                    <StoreCard key={e.id} entry={e} selected={search.entry === e.slug} onSelect={() => setSearch({ entry: e.slug })} />
                  ))}
                </div>
              );
            }}
          </QueryBoundary>
        </div>
        {search.entry && wide ? (
          entry ? (
            <EntryDetail docked entry={entry} onClose={close} onInstall={() => setInstalling(true)} />
          ) : (
            <div className="w-[400px] shrink-0" role="status" aria-label="Loading details" />
          )
        ) : null}
      </div>

      {search.entry && !wide ? (
        <Dialog open onOpenChange={(o) => !o && close()}>
          <DialogContent title={entry?.displayName ?? 'Server details'} placement="drawer" hideTitle>
            {entry ? <EntryDetail entry={entry} onInstall={() => setInstalling(true)} /> : <p>Loading…</p>}
          </DialogContent>
        </Dialog>
      ) : null}

      {entry ? <InstallFlow entry={entry} open={installing} onOpenChange={setInstalling} /> : null}
    </>
  );
}
