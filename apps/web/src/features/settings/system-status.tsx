import { useSystemStatus } from '@/api/hooks';
import { Card, CardHeader, Legend } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusDot } from '@/components/status';
import { formatDate, formatUptime, percent } from '@/lib/format';

const queueColor = (pct: number) =>
  pct > 55 ? 'var(--sun)' : pct > 20 ? 'var(--sky)' : 'var(--mint)';

/** System status (15.7): replica tiles, queue bars, dependency dots and the registry sync timeline. */
export function SystemStatusSection() {
  const q = useSystemStatus();
  return (
    <QueryBoundary query={q} label="Loading system status">
      {(s) => (
        <div className="flex flex-col gap-6">
          <Card aria-label="Replicas" className="gap-3.5">
            <CardHeader
              title="Replicas"
              actions={
                <Legend
                  items={[
                    { label: 'worker', color: 'var(--tangerine)' },
                    { label: 'ui', color: 'var(--sky)' },
                  ]}
                />
              }
            />
            <ul className="m-0 grid list-none grid-cols-2 gap-2.5 p-0 sm:grid-cols-4 2xl:grid-cols-8">
              {s.replicas.map((r) => {
                const color = r.role === 'worker' ? 'var(--tangerine)' : 'var(--sky)';
                return (
                  <li
                    key={r.id}
                    className="relative flex flex-col gap-2 overflow-hidden rounded-md bg-sunken p-3 pt-3.5"
                  >
                    <span
                      className="absolute inset-x-0 top-0 h-1"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    <div className="flex items-center gap-1.5">
                      <StatusDot
                        tone={r.rollingOut ? 'warn' : 'ok'}
                        label={r.rollingOut ? 'Rolling out' : 'Healthy'}
                        hideLabel
                      />
                      <span className="text-[13px] font-semibold">{r.id}</span>
                    </div>
                    <span className="text-[11px] leading-[14px] text-muted">
                      {r.version}
                      {r.rollingOut ? ' · rolling out' : ''}
                    </span>
                    <span
                      className="h-1.5 overflow-hidden rounded-[3px] bg-line"
                      aria-hidden="true"
                    >
                      <span
                        className="block h-full"
                        style={{
                          width: `${Math.min(100, (r.uptimeSec / (7 * 86400)) * 100)}%`,
                          background: color,
                        }}
                      />
                    </span>
                    <span className="text-[11px] leading-[14px] text-muted">
                      up {formatUptime(r.uptimeSec)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card aria-label="Queues" className="gap-3.5">
              <CardHeader title="Queues" />
              {s.queues.map((qu) => {
                const pct = percent(qu.depth, qu.capacity);
                return (
                  <div
                    key={qu.name}
                    className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3"
                    title={`${qu.name}: ${qu.depth} of ${qu.capacity}`}
                  >
                    <span className="text-[13px] font-medium">{qu.name}</span>
                    <span
                      className="h-3 overflow-hidden rounded-sm bg-sunken"
                      role="progressbar"
                      aria-label={`${qu.name} depth`}
                      aria-valuemin={0}
                      aria-valuemax={qu.capacity}
                      aria-valuenow={qu.depth}
                    >
                      <span
                        className="block h-full rounded-sm"
                        style={{ width: `${pct}%`, background: queueColor(pct) }}
                      />
                    </span>
                  </div>
                );
              })}
            </Card>
            <Card aria-label="Dependencies" className="gap-1">
              <CardHeader title="Dependencies" className="mb-2" />
              {s.checks.map((c) => (
                <div
                  key={c.name}
                  className="flex min-h-10 items-center gap-2.5 border-b border-line"
                >
                  <StatusDot
                    tone={c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'bad'}
                    label={c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'Slow' : 'Down'}
                    hideLabel
                  />
                  <span className="flex-1 text-[13px] font-medium">{c.name}</span>
                  <span className="text-caption text-muted">{c.detail}</span>
                </div>
              ))}
            </Card>
          </div>
          <Card aria-label="Registry sync" className="gap-3.5">
            <CardHeader
              title="Registry sync"
              actions={
                <Legend
                  items={[
                    { label: 'Synced', color: 'var(--mint)' },
                    { label: 'Failed', color: 'var(--coral)', shape: 'bar' },
                  ]}
                />
              }
            />
            {s.registrySync.map((src) => (
              <div
                key={src.sourceId}
                className="grid grid-cols-[200px_minmax(0,1fr)] items-center gap-3 max-md:grid-cols-1"
              >
                <span className="text-[13px] font-medium">{src.name}</span>
                <ul
                  className="m-0 flex h-5 list-none items-center gap-1 p-0"
                  aria-label={`${src.name} sync history`}
                >
                  {src.runs.map((r) => (
                    <li
                      key={r.at}
                      title={`${r.ok ? 'Synced' : 'Failed'} · ${formatDate(r.at)}`}
                      className="flex-1"
                      style={{
                        height: r.ok ? 10 : 18,
                        borderRadius: r.ok ? 9999 : 3,
                        background: r.ok ? 'var(--mint)' : 'var(--coral)',
                      }}
                    >
                      <span className="sr-only">
                        {r.ok ? 'Synced' : 'Failed'} {formatDate(r.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-3 text-caption text-muted max-md:hidden">
              <span />
              <span className="flex justify-between">
                <span>7 days ago</span>
                <span>Today</span>
              </span>
            </div>
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}
