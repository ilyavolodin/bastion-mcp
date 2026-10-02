import { Link } from '@tanstack/react-router';
import { Plus, Server } from 'lucide-react';
import { z } from 'zod';
import { useInstallations } from '@/api/hooks';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { CardsSkeleton, QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSearchState } from '@/lib/search';
import { EndpointsPanel } from './endpoints-panel';
import { InstallationTile } from './installation-tile';

const searchSchema = z.object({
  tab: z.enum(['servers', 'endpoints']).catch('servers').default('servers'),
});

export function ServersPage() {
  const [s, setS] = useSearchState(searchSchema);
  const q = useInstallations();
  return (
    <>
      <PageHeader
        title="My servers"
        subtitle="Everything installed for you, your teams and your endpoints."
        actions={
          <Button asChild variant="outline">
            <Link to="/store">
              <Plus className="size-4" aria-hidden="true" />
              Add from the store
            </Link>
          </Button>
        }
      />
      <Tabs value={s.tab} onValueChange={(v) => setS({ tab: v as 'servers' | 'endpoints' })}>
        <TabsList aria-label="My servers sections">
          <TabsTrigger value="servers">Servers</TabsTrigger>
          <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
        </TabsList>
        <TabsContent value="servers">
          <QueryBoundary
            query={q}
            skeleton={<CardsSkeleton count={4} className="h-[150px]" />}
            isEmpty={(d) => d.length === 0}
            empty={
              <EmptyState
                icon={<Server />}
                title="Install your first server"
                description="Servers give your AI tools something to work with."
                action={{ label: 'Browse the store', to: '/store' }}
              />
            }
          >
            {(items) => (
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {items.map((i) => (
                  <InstallationTile key={i.id} installation={i} />
                ))}
              </div>
            )}
          </QueryBoundary>
        </TabsContent>
        <TabsContent value="endpoints">
          <EndpointsPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}
