import { z } from 'zod';
import { type StatsScope, useNames } from '@/api/hooks';
import type { StatsRange } from '@/api/views/observability';
import { useAuth } from '@/auth/auth';
import { PageHeader } from '@/components/page-header';
import { Segmented } from '@/components/primitives';
import { Select } from '@/components/ui/input';
import { useSearchState } from '@/lib/search';
import { HealthPanel, LatencyPanel, PeoplePanel, SandboxPanel, TrafficPanel } from './panels';

const searchSchema = z.object({
  range: z.enum(['1h', '24h', '7d']).catch('24h').default('24h'),
  scope: z.enum(['org', 'team', 'person']).optional().catch(undefined),
  /** The person of the `person` scope. */
  person: z.coerce.string().optional(),
});

export function ObservabilityPage() {
  const { me, role } = useAuth();
  const [s, setS] = useSearchState(searchSchema);
  const names = useNames();
  const team = me.teams.find((t) => t.role === 'manager') ?? me.teams[0];
  const orgAllowed = role === 'admin' || role === 'auditor';
  const asked = orgAllowed ? (s.scope ?? 'org') : 'team';
  // A person's own view needs somebody chosen: until then the whole org is shown.
  const scope: 'org' | 'team' | 'person' = asked === 'person' && !s.person ? 'org' : asked;
  const args: { range: StatsRange } & StatsScope = {
    range: s.range,
    scope,
    ...(scope === 'team' && team ? { teamId: team.id } : {}),
    ...(scope === 'person' && s.person ? { userId: s.person } : {}),
  };
  const people = [...(names.data?.users.entries() ?? [])].sort((a, b) => a[1].localeCompare(b[1]));
  const personName = s.person ? (names.data?.users.get(s.person) ?? s.person) : undefined;
  return (
    <>
      <PageHeader
        title="Observability"
        subtitle={
          scope === 'person'
            ? `Traffic of ${personName ?? 'one person'}.`
            : `Traffic, health and sandboxes for ${scope === 'team' ? 'the teams you manage' : 'the whole org'}.`
        }
        actions={
          <div className="flex flex-wrap gap-3">
            {orgAllowed || role === 'manager' ? (
              <Segmented
                label="Scope"
                value={scope === 'person' ? 'person' : scope}
                onChange={(v) => setS({ scope: v })}
                options={[
                  ...(orgAllowed ? [{ value: 'org' as const, label: 'Whole org' }] : []),
                  { value: 'team' as const, label: team?.name ?? 'My team' },
                  ...(orgAllowed ? [{ value: 'person' as const, label: 'A person' }] : []),
                ]}
              />
            ) : null}
            {orgAllowed && asked === 'person' ? (
              <Select
                aria-label="Person"
                value={s.person ?? ''}
                className="h-11 min-w-48"
                onChange={(e) => setS({ scope: 'person', person: e.target.value || undefined })}
              >
                <option value="">Choose a person</option>
                {people.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
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
        {scope === 'person' ? null : <PeoplePanel args={args} />}
        <LatencyPanel args={args} enabled={orgAllowed && scope !== 'person'} />
        {scope === 'person' ? null : <SandboxPanel args={args} enabled={orgAllowed} />}
      </div>
    </>
  );
}
