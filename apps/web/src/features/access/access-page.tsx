import { Code2 } from 'lucide-react';
import * as React from 'react';
import { z } from 'zod';
import { useAuth } from '@/auth/auth';
import { PageHeader } from '@/components/page-header';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSearchState } from '@/lib/search';
import {
  OAuthClientsTab,
  PeopleTab,
  RoleMappingTab,
  ServiceAccountsTab,
  TeamsTab,
} from './directory';
import { CedarDialog, RulesTab } from './rules';

const TABS = ['people', 'teams', 'mapping', 'service', 'clients', 'rules'] as const;
const searchSchema = z.object({
  tab: z.enum(TABS).catch('rules').default('rules'),
  q: z.coerce.string().optional(),
});

export function AccessPage() {
  const { role } = useAuth();
  const [s, setS] = useSearchState(searchSchema);
  const [cedar, setCedar] = React.useState(false);
  return (
    <>
      <PageHeader
        title="Access"
        subtitle="People, teams and the rules that decide which tools they can see and call."
        actions={
          <RoleGate roles={['admin']}>
            <Button variant="outline" onClick={() => setCedar(true)}>
              <Code2 className="size-4" aria-hidden="true" />
              Custom Cedar policies
            </Button>
          </RoleGate>
        }
      />
      <Tabs value={s.tab} onValueChange={(v) => setS({ tab: v as (typeof TABS)[number] })}>
        <TabsList aria-label="Access sections">
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          {role === 'admin' ? <TabsTrigger value="mapping">IdP group mapping</TabsTrigger> : null}
          <TabsTrigger value="service">Service accounts</TabsTrigger>
          {role === 'admin' ? <TabsTrigger value="clients">OAuth clients</TabsTrigger> : null}
          <TabsTrigger value="rules">Tool rules</TabsTrigger>
        </TabsList>
        <TabsContent value="people">
          <PeopleTab initialQuery={s.q} />
        </TabsContent>
        <TabsContent value="teams">
          <TeamsTab />
        </TabsContent>
        {role === 'admin' ? (
          <TabsContent value="mapping">
            <RoleMappingTab />
          </TabsContent>
        ) : null}
        <TabsContent value="service">
          <ServiceAccountsTab />
        </TabsContent>
        {role === 'admin' ? (
          <TabsContent value="clients">
            <OAuthClientsTab />
          </TabsContent>
        ) : null}
        <TabsContent value="rules">
          <RulesTab />
        </TabsContent>
      </Tabs>
      {role === 'admin' ? <CedarDialog open={cedar} onOpenChange={setCedar} /> : null}
    </>
  );
}
