import { useSystemStatus } from '@/api/hooks';
import { queueRows, rollingOutReplicas } from '@/api/views/settings';
import { Card, CardHeader, Legend } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusDot } from '@/components/status';
import { formatDate, formatRelative, formatUptime, percent, secondsSince } from '@/lib/format';
import { SECOND, WEEK_MS } from '@/lib/time';

const queueColor = (pct: number) =>
  pct > 55 ? 'var(--sun)' : pct > 20 ? 'var(--sky)' : 'var(--mint)';

/** A queue bar fills against 100 jobs, or the queue itself when it is deeper. */
const QUEUE_SCALE = 100;

/** System status (15.7): replica tiles, queue bars, dependency dots and the registry sync state. */
export function SystemStatusSection() {
  const q = useSystemStatus();
  return (
    <QueryBoundary query={q} label="Loading system status">
      {(s) => {
        const rolling = rollingOutReplicas(s.replicas);
        const queues = queueRows(s.queues);
        const checks = [
          {
            name: 'Sandbox driver',
            ok: s.driver.healthy,
            detail: s.driver.detail ? `${s.driver.name} · ${s.driver.detail}` : s.driver.name,
          },
          { name: 'Key management', ok: s.kms.healthy, detail: s.kms.provider },
        ];
        return (
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
                  const rollingOut = rolling.has(r.id);
                  const uptimeSec = secondsSince(r.startedAt, q.dataUpdatedAt);
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
                          tone={rollingOut ? 'warn' : 'ok'}
                          label={rollingOut ? 'Rolling out' : 'Healthy'}
                          hideLabel
                        />
                        <span className="text-[13px] font-semibold">{r.id}</span>
                      </div>
                      <span className="text-[11px] leading-[14px] text-muted">
                        {r.version}
                        {rollingOut ? ' · rolling out' : ''}
                      </span>
                      <span
                        className="h-1.5 overflow-hidden rounded-[3px] bg-line"
                        aria-hidden="true"
                      >
                        <span
                          className="block h-full"
                          style={{
                            width: `${percent(uptimeSec, WEEK_MS / SECOND)}%`,
                            background: color,
                          }}
                        />
                      </span>
                      <span className="text-[11px] leading-[14px] text-muted">
                        up {formatUptime(uptimeSec)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card aria-label="Queues" className="gap-3.5">
                <CardHeader title="Queues" />
                {queues.length === 0 ? (
                  <p className="m-0 text-muted">No jobs are waiting.</p>
                ) : null}
                {queues.map((qu) => {
                  const scale = Math.max(QUEUE_SCALE, qu.depth);
                  const pct = percent(qu.depth, scale);
                  return (
                    <div
                      key={qu.name}
                      className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3"
                      title={`${qu.name}: ${qu.depth} waiting${qu.oldestAgeSeconds === undefined ? '' : `, oldest ${qu.oldestAgeSeconds} s`}`}
                    >
                      <span className="break-all text-[13px] font-medium">{qu.name}</span>
                      <span
                        className="h-3 overflow-hidden rounded-sm bg-sunken"
                        role="progressbar"
                        aria-label={`${qu.name} depth`}
                        aria-valuemin={0}
                        aria-valuemax={scale}
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
                {checks.map((c) => (
                  <div
                    key={c.name}
                    className="flex min-h-10 items-center gap-2.5 border-b border-line"
                  >
                    <StatusDot tone={c.ok ? 'ok' : 'bad'} label={c.ok ? 'OK' : 'Down'} hideLabel />
                    <span className="flex-1 text-[13px] font-medium">{c.name}</span>
                    <span className="text-caption text-muted">{c.detail}</span>
                  </div>
                ))}
                <div className="flex min-h-10 items-center gap-2.5 border-b border-line">
                  <span className="flex-1 text-[13px] font-medium">Active sandbox leases</span>
                  <span className="text-caption text-muted">{s.leases.active}</span>
                </div>
                <div className="flex min-h-10 items-center gap-2.5">
                  <span className="flex-1 text-[13px] font-medium">Config version</span>
                  <span className="font-mono text-caption text-muted">{s.configVersion}</span>
                </div>
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
              {s.registrySync.length === 0 ? (
                <p className="m-0 text-muted">No registry sources are configured.</p>
              ) : null}
              {s.registrySync.map((src) => (
                <div
                  key={src.sourceId}
                  className="grid grid-cols-[200px_minmax(0,1fr)] items-center gap-3 max-md:grid-cols-1"
                >
                  <span className="text-[13px] font-medium">{src.name}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusDot
                      tone={src.ok === null ? 'neutral' : src.ok ? 'ok' : 'bad'}
                      label={src.ok === null ? 'Never synced' : src.ok ? 'Synced' : 'Failed'}
                    />
                    {src.lastSyncAt ? (
                      <span className="text-caption text-muted" title={formatDate(src.lastSyncAt)}>
                        {formatRelative(src.lastSyncAt)}
                      </span>
                    ) : null}
                    {src.error ? (
                      <span className="text-caption text-coral-ink">{src.error}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </Card>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
