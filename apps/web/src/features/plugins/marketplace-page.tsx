import { useParams } from '@tanstack/react-router';
import { useMarketplace, useRollout } from '@/api/hooks';
import { CopyField } from '@/components/copy-field';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { useAuth } from '@/auth/auth';
import { NotInNavigation } from '@/components/role-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { PluginCard, ReleasesCard } from './parts';

const ROLLOUT_CLIENTS = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['claude-desktop-3p', 'Claude Desktop (3P)'],
  ['claude-ai', 'claude.ai'],
  ['chatgpt', 'ChatGPT'],
] as const;

function RolloutCard({ marketplaceId, client, label }: { marketplaceId: string; client: string; label: string }) {
  const q = useRollout(marketplaceId, client);
  return (
    <Card aria-label={`${label} rollout`} className="gap-3">
      <CardHeader title={label} actions={q.data ? <Tag tone={q.data.kind === 'snippet' ? 'info' : 'warn'}>{q.data.kind === 'snippet' ? 'Config' : 'Checklist'}</Tag> : undefined} />
      {q.isPending ? <Skeleton className="h-24 w-full" /> : q.data ? (
        <>
          <p className="m-0 text-caption text-muted">{q.data.label}</p>
          <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-[#171a3a] p-3 font-mono text-[12px] leading-5 text-[#f4f4f6]">{q.data.content}</pre>
          <CopyField value={q.data.content} label={`${label} ${q.data.kind === 'snippet' ? 'configuration' : 'checklist'}`} tone="sunken" buttonLabel="Copy" className="[&>span:first-child]:text-[13px]" />
        </>
      ) : null}
    </Card>
  );
}

/** Marketplace page (Managers, Admins): plugins with policy chips, releases, mirror, rollout cards, adoption (18.3, 25.7). */
export function MarketplacePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { role } = useAuth();
  const q = useMarketplace(id);
  if (role !== 'admin' && role !== 'manager') return <NotInNavigation section="catalog" />;
  return (
    <QueryBoundary query={q} label="Loading marketplace">
      {(m) => (
        <>
          <PageHeader back={{ to: '/plugins', label: 'Plugins' }} title={m.name} subtitle={`Marketplace · ${m.owner} · ${m.plugins.length} plugins`} />
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
                {m.plugins.map((p) => <PluginCard key={p.entryId} p={p} showPolicy />)}
              </div>
              <section aria-label="Rollout" className="flex flex-col gap-3.5">
                <h2 className="m-0 text-card-title">Rollout configuration</h2>
                <div className="grid gap-4 lg:grid-cols-2">
                  {ROLLOUT_CLIENTS.map(([c, label]) => <RolloutCard key={c} marketplaceId={m.id} client={c} label={label} />)}
                </div>
              </section>
            </div>
            <ReleasesCard id={m.id} />
          </div>
        </>
      )}
    </QueryBoundary>
  );
}


