import { z } from 'zod';
import type { StatsRange, StatsScope } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { PageHeader } from '@/components/page-header';
import { Segmented } from '@/components/primitives';
import { useSearchState } from '@/lib/search';
import { HealthPanel, LatencyPanel, SandboxPanel, TrafficPanel } from './panels';

const searchSchema = z.object({
  range: z.enum(['1h', '24h', '7d']).catch('24h').default('24h'),
  scope: z.enum(['org', 'team']).optional().catch(undefined),
});

export function ObservabilityPage() {
  const { me, role } = useAuth();
  const [s, setS] = useSearchState(searchSchema);
  const team = me.teams.find((t) => t.role === 'manager') ?? me.teams[0];
  const orgAllowed = role === 'admin' || role === 'auditor';
  const scope: 'org' | 'team' = orgAllowed ? (s.scope ?? 'org') : 'team';
  const args: { range: StatsRange } & StatsScope = {
    range: s.range,
    scope,
    ...(scope === 'team' && team ? { teamId: team.id } : {}),
  };
  return (
    <>
      <PageHeader
        title="Observability"
        subtitle={`Traffic, health and sandboxes for ${scope === 'team' ? 'the teams you manage' : 'the whole org'}.`}
        actions={
          <div className="flex flex-wrap gap-3">
            {orgAllowed || role === 'manager' ? (
              <Segmented
                label="Scope"
                value={scope}
                onChange={(v) => setS({ scope: v })}
                options={[
                  ...(orgAllowed ? [{ value: 'org' as const, label: 'Whole org' }] : []),
                  { value: 'team' as const, label: team?.name ?? 'My team' },
                ]}
              />
            ) : null}
            <Segmented
              label="Time range"
              value={s.range}
              onChange={(v) => setS({ range: v })}
              options={[
                { value: '1h', label: '1h' },
                { value: '24h', label: '24h' },
                { value: '7d', label: '7d' },
              ]}
            />
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <TrafficPanel args={args} />
        <HealthPanel args={args} />
        <LatencyPanel args={args} />
        <SandboxPanel args={args} />
      </div>
    </>
  );
}
