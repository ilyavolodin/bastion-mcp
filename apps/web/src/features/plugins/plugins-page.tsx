import { Link } from '@tanstack/react-router';
import { Plug, Plus } from 'lucide-react';
import { useClientSetup, useMarketplaces } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import { ApprovalsCard, ClientSetupCard, PluginCard, ReleasesCard } from './parts';

export function PluginsPage() {
  const { role } = useAuth();
  const q = useMarketplaces();
  const first = q.data?.[0];
  const clients = useClientSetup(first?.id);
  return (
    <>
      <PageHeader
        title="Plugins"
        subtitle="Skills, commands and tools from the marketplaces you belong to."
        actions={
          <RoleGate roles={['admin', 'manager']}>
            <Button asChild variant="outline">
              <Link to="/plugins/edit/$id" params={{ id: 'new' }}>
                <Plus className="size-4" aria-hidden="true" />
                Author a plugin
              </Link>
            </Button>
          </RoleGate>
        }
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<Plug />}
            title="No marketplaces yet"
            description="An admin or manager creates a marketplace and adds plugins to it."
            action={
              role === 'admin' || role === 'manager'
                ? { label: 'Author a plugin', to: '/plugins/edit/new' }
                : undefined
            }
          />
        }
      >
        {(markets) => (
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <Card aria-label="Set up your clients" className="gap-3.5">
                <CardHeader title="Set up your clients" />
                <div className="grid gap-3 md:grid-cols-2">
                  {clients.setups.map((c) => (
                    <ClientSetupCard key={c.client} c={c} />
                  ))}
                </div>
              </Card>
              {markets.map((m) => (
                <section
                  key={m.id}
                  aria-label={`${m.name} marketplace`}
                  className="flex flex-col gap-3.5"
                >
                  <div className="flex items-baseline gap-3">
                    <h2 className="m-0 flex-1 text-card-title">{m.name}</h2>
                    <span className="text-caption text-muted">
                      Marketplace · {m.plugins.length} plugins
                    </span>
                    {m.canManage ? (
                      <Link to={`/plugins/marketplace/${m.id}`} className="text-label no-underline">
                        Manage
                      </Link>
                    ) : null}
                  </div>
                  <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
                    {m.plugins.map((p) => (
                      <PluginCard key={p.slug} p={p} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <div className="flex min-w-0 flex-col gap-6">
              {first?.canManage ? <ReleasesCard id={first.id} link /> : null}
              <RoleGate roles={['admin']}>
                <ApprovalsCard />
              </RoleGate>
            </div>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
