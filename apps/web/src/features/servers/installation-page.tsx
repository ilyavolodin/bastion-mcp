import { useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { useInstallation, usePatchInstallation } from '@/api/hooks';
import type { InstallationView } from '@/api/views/servers';
import { PageHeader } from '@/components/page-header';
import { ServerIcon, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { InstallationStatus } from '@/components/status';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CallExplorer } from '@/features/activity/call-explorer';
import { RUNTIME_LABEL } from '@/lib/format';
import { useSearchState } from '@/lib/search';
import { CapabilitiesTab } from './tabs/capabilities';
import { ConnectionTab } from './tabs/connection-tab';
import { LogsTab } from './tabs/logs-tab';
import { NetworkTab } from './tabs/network-tab';
import { OverridesTab } from './tabs/overrides-tab';
import { OverviewTab } from './tabs/overview';
import { SettingsTab } from './tabs/settings-tab';

const TABS = [
  'overview',
  'capabilities',
  'overrides',
  'connection',
  'activity',
  'logs',
  'network',
  'settings',
] as const;
const searchSchema = z.object({ tab: z.enum(TABS).catch('overview').default('overview') });

function Body({ installation: i }: { installation: InstallationView }) {
  const [s, setS] = useSearchState(searchSchema);
  const patch = usePatchInstallation(i.id);
  return (
    <>
      <PageHeader
        back={{ to: '/servers', label: 'My servers' }}
        icon={<ServerIcon letter={i.letter} color={i.color} size={56} />}
        title={i.displayName}
        badge={<InstallationStatus status={i.status} variant="pill" />}
        subtitle={
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <Tag tone="surface">
              {RUNTIME_LABEL[i.runtime]}
              {i.package
                ? ` · ${i.package}${i.versionLabel ? ` ${i.versionLabel}` : ''}`
                : i.versionLabel
                  ? ` · v${i.versionLabel}`
                  : ''}
            </Tag>
            {i.sandboxed ? <Tag tone="info">Sandbox</Tag> : null}
            {i.followsCurrent ? <Tag tone="ok">Updates itself</Tag> : null}
            {i.latestVersionLabel ? (
              <Tag tone="warn">Pinned · v{i.latestVersionLabel} is available</Tag>
            ) : null}
            {i.ownerType === 'team' ? <Tag tone="berry">Team · {i.ownerName}</Tag> : null}
          </span>
        }
        actions={
          <label className="inline-flex h-11 items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3.5 text-label">
            <Switch
              checked={i.enabled}
              onCheckedChange={(v) => patch.mutate({ enabled: v })}
              aria-label={i.ownerType === 'team' ? 'Enabled for the team' : 'Enabled'}
            />
            {i.ownerType === 'team' ? 'Enabled for the team' : 'Enabled'}
          </label>
        }
      />
      <Tabs value={s.tab} onValueChange={(v) => setS({ tab: v as (typeof TABS)[number] })}>
        <TabsList aria-label="Installation sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
          <TabsTrigger value="overrides">Overrides</TabsTrigger>
          <TabsTrigger value="connection">Connection</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab
            installation={i}
            goTo={(tab) => setS({ tab: tab as (typeof TABS)[number] })}
          />
        </TabsContent>
        <TabsContent value="capabilities">
          <CapabilitiesTab installationId={i.id} />
        </TabsContent>
        <TabsContent value="overrides">
          <OverridesTab installationId={i.id} catalogEntryId={i.catalogEntryId ?? null} />
        </TabsContent>
        <TabsContent value="connection">
          <ConnectionTab installation={i} />
        </TabsContent>
        <TabsContent value="activity">
          <div className="flex flex-col gap-6">
            <CallExplorer fixedInstallationId={i.id} />
          </div>
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab installation={i} />
        </TabsContent>
        <TabsContent value="network">
          <NetworkTab installation={i} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab installation={i} />
        </TabsContent>
      </Tabs>
    </>
  );
}

export function InstallationPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useInstallation(id);
  return (
    <QueryBoundary query={q} label="Loading server">
      {(i) => <Body installation={i} />}
    </QueryBoundary>
  );
}
