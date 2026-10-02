import { Link } from '@tanstack/react-router';
import { Server, TriangleAlert } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis } from 'recharts';
import { useCallSeries, useInstallations, useQuotas, useTeams, useUsers } from '@/api/hooks';
import type { QuotaView } from '@/api/views/session';
import { useAuth } from '@/auth/auth';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, dayLabel, GRID } from '@/components/charts';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Avatar, Card, CardHeader, Tag } from '@/components/primitives';
import { CardsSkeleton, QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatNumber, installationAction, percent } from '@/lib/format';
import { InstallationTile } from '../servers/installation-tile';
import { useInstallationAction } from '../servers/use-installation-action';
import { ConnectCard } from './connect-card';
import { DecisionsCard } from './decisions-card';

const BAR_COLORS = ['var(--tangerine)', 'var(--sky)', 'var(--teal)'];

export const quotaText = (q: QuotaView): string =>
  q.mode === 'left'
    ? `${formatNumber(q.limit - q.used)} left of ${formatNumber(q.limit)}`
    : `${formatNumber(q.used)} of ${formatNumber(q.limit)} in use`;

function SetupBanner() {
  const { data } = useInstallations();
  const { run, pending } = useInstallationAction();
  const needy = (data ?? []).filter((i) => installationAction(i) !== null);
  const first = needy[0];
  if (!first) return null;
  const action = installationAction(first);
  const message =
    first.status === 'error'
      ? `${first.displayName} isn’t starting.`
      : first.status === 'reconnect_required'
        ? `${first.displayName} needs you to sign in again.`
        : first.authMode === 'oauth'
          ? `${first.displayName} isn’t connected yet.`
          : `${first.displayName} needs an API key.`;
  const tail =
    first.status === 'error'
      ? 'See why, then restart it.'
      : 'Its tools stay out of your AI tools until you sign in.';
  return (
    <section
      aria-label="Setup"
      className="flex flex-wrap items-center gap-4 rounded-lg bg-tangerine-soft px-5 py-3.5"
    >
      <TriangleAlert className="size-[22px] text-tangerine-ink" aria-hidden="true" />
      <p className="m-0 min-w-0 flex-1">
        <strong className="font-semibold">{message}</strong> {tail}
        {needy.length > 1
          ? ` ${needy.length - 1} more ${needy.length === 2 ? 'server needs' : 'servers need'} attention below.`
          : ''}
      </p>
      <Button disabled={pending} onClick={() => run(first)}>
        {action?.label}
      </Button>
    </section>
  );
}

function QuotasCard() {
  const q = useQuotas();
  return (
    <Card aria-label="Your quotas" className="gap-4">
      <CardHeader title="Your quotas today" />
      <QueryBoundary query={q} label="Loading quotas">
        {(items) =>
          items.map((quota, i) => {
            const pct = percent(
              quota.mode === 'left' ? quota.limit - quota.used : quota.used,
              quota.limit,
            );
            return (
              <div key={quota.id} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 text-label">{quota.name}</span>
                  <span className="text-figure-sm">{quotaText(quota)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={quota.name}
                  aria-valuemin={0}
                  aria-valuemax={quota.limit}
                  aria-valuenow={quota.mode === 'left' ? quota.limit - quota.used : quota.used}
                  className="h-2.5 overflow-hidden rounded-sm bg-sunken"
                >
                  <div
                    className="h-full rounded-sm"
                    style={{ width: `${pct}%`, background: BAR_COLORS[i % BAR_COLORS.length] }}
                  />
                </div>
              </div>
            );
          })
        }
      </QueryBoundary>
    </Card>
  );
}

function WeekCard() {
  const q = useCallSeries({ range: '7d', scope: 'me' });
  const buckets = q.data?.buckets ?? [];
  const busier = q.data?.trend === 'up';
  return (
    <ChartCard
      title="Your last 7 days"
      table={{
        columns: ['Day', 'Calls'],
        rows: buckets.map((b) => [dayLabel(b.t), b.calls]),
      }}
      legend={
        q.data && q.data.trend !== 'flat' ? (
          <Tag tone={busier ? 'ok' : 'neutral'} className="h-6">
            {busier ? '↑ busier than last week' : '↓ quieter than last week'}
          </Tag>
        ) : undefined
      }
    >
      <QueryBoundary query={q} label="Loading activity">
        {() => (
          <AutoSize height={130}>
            <AreaChart
              data={buckets}
              margin={{ top: 6, right: 0, left: 0, bottom: 0 }}
              accessibilityLayer={false}
            >
              <defs>
                <linearGradient id="homeArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--tangerine)" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="var(--tangerine)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="t"
                tickFormatter={dayLabel}
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip labelFormat={dayLabel} />} />
              <Area
                type="monotone"
                dataKey="calls"
                name="Calls"
                stroke="var(--tangerine)"
                strokeWidth={2.5}
                fill="url(#homeArea)"
              />
            </AreaChart>
          </AutoSize>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

/** Admin and Manager: who in the team has connected an AI tool this week. */
function TeamCard() {
  const { me, role } = useAuth();
  const teams = useTeams(role === 'admin');
  const myTeam = me.teams.find((t) => t.role === 'manager') ?? me.teams[0];
  const team =
    role === 'admin' ? (teams.data?.find((t) => t.id === myTeam?.id) ?? teams.data?.[0]) : myTeam;
  const users = useUsers(team ? { teamId: team.id } : {});
  const weekAgo = Date.now() - 7 * 86_400_000;
  const people = users.data ?? [];
  const connected = (u: (typeof people)[number]) =>
    u.lastActiveAt !== null && new Date(u.lastActiveAt).getTime() > weekAgo;
  const missing = people.filter((u) => !connected(u)).length;
  return (
    <Card aria-label="Team adoption" className="gap-3.5">
      <CardHeader title={team?.name ?? 'Your team'} />
      <p className="m-0 text-muted">Who has connected an AI tool this week</p>
      <ul className="m-0 grid list-none grid-cols-7 gap-1.5 p-0">
        {people.slice(0, 14).map((u) => {
          const on = connected(u);
          return (
            <li
              key={u.id}
              className="flex justify-center"
              title={`${u.name}: ${on ? 'connected' : 'not yet'}`}
            >
              <Avatar name={u.name} size={36} dashed={!on} color="var(--sky)" />
              <span className="sr-only">{on ? 'connected' : 'not yet connected'}</span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 text-caption text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full bg-sky" aria-hidden="true" />
          Connected
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="size-2 rounded-full border-[1.5px] border-dashed border-line-strong"
            aria-hidden="true"
          />
          Not yet
        </span>
        {missing > 0 ? (
          <Link to="/access" search={{ tab: 'people' }} className="ml-auto text-label no-underline">
            Nudge {missing} {missing === 1 ? 'person' : 'people'}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

export function HomePage() {
  const { me, role } = useAuth();
  const installations = useInstallations();
  return (
    <>
      <PageHeader title="Home" subtitle={`${me.org.name} · ${me.org.host}`} />
      <SetupBanner />
      <div className="flex flex-wrap items-stretch gap-6">
        <ConnectCard />
        {role === 'admin' || role === 'manager' || role === 'auditor' ? <DecisionsCard /> : null}
      </div>
      <section aria-label="My servers" className="flex flex-col gap-4">
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 text-card-title">My servers</h2>
          <span className="flex-1 text-caption text-muted">Calls in the last 24 hours</span>
          <Link to="/store" className="text-label no-underline">
            Browse the store
          </Link>
        </div>
        <QueryBoundary
          query={installations}
          label="Loading servers"
          skeleton={<CardsSkeleton count={4} className="h-[150px]" />}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              icon={<Server />}
              title="Install your first server"
              description="Servers give your AI tools something to work with: tickets, code, data."
              action={{ label: 'Browse the store', to: '/store' }}
            />
          }
        >
          {(items) => (
            <div
              className={cn(
                'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]',
              )}
            >
              {items
                .filter((i) => !i.hidden)
                .map((i) => (
                  <InstallationTile key={i.id} installation={i} />
                ))}
            </div>
          )}
        </QueryBoundary>
      </section>
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
        <QuotasCard />
        <WeekCard />
        {role === 'admin' || role === 'manager' ? <TeamCard /> : null}
      </div>
    </>
  );
}
