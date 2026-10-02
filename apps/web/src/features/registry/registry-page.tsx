import { Link } from '@tanstack/react-router';
import { Globe, Search, Settings } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import {
  useApproveRequest,
  useCreateInstallRequest,
  useInstallRequests,
  useRegistryInstall,
  useRegistryServers,
  useRegistrySources,
  useRejectRequest,
} from '@/api/hooks';
import {
  type InstallRequestView,
  isSyncing,
  type RegistryServerView,
  reasonsText,
  runtimeLabel,
  serverKey,
  syncInfo,
  TRUST_LABEL,
} from '@/api/views/registry';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { Avatar, Card, CardHeader, Segmented, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { fieldErrors } from '@/features/access/forms';
import { formatRelative } from '@/lib/format';
import {
  installToBody,
  rejectFormSchema,
  rejectToBody,
  requestFormSchema,
  requestToBody,
} from './forms';

/** A server the policy wants approval for, with what the policy said. */
type Pending = { server: RegistryServerView; reasons: string[] };

function RequestDialog({ pending, onClose }: { pending: Pending | null; onClose: () => void }) {
  const create = useCreateInstallRequest();
  const [justification, setJustification] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  const server = pending?.server;
  return (
    <Dialog open={pending !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Request ${server?.name ?? ''}`}
        description={
          pending && pending.reasons.length > 0
            ? `${reasonsText(pending.reasons)} A manager or admin reviews the request before it is installed.`
            : 'A manager or admin reviews the request before it is installed.'
        }
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!server) return;
            const parsed = requestFormSchema.safeParse({ justification });
            if (!parsed.success) return setError(fieldErrors(parsed.error).justification);
            setError(undefined);
            create.mutate(requestToBody(server, parsed.data), {
              onSuccess: () => {
                toast.success('Request sent');
                setJustification('');
                onClose();
              },
              onError: (err) => {
                if (err instanceof ApiError) setError(err.errors[0]?.message ?? err.detail);
              },
            });
          }}
        >
          <Field label="What do you need it for?" required error={error}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                maxLength={2000}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Send request
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ServerCard({
  s,
  blocked,
  onBlocked,
  onNeedsRequest,
  onSourceDisabled,
}: {
  s: RegistryServerView;
  blocked: boolean;
  onBlocked: () => void;
  onNeedsRequest: (reasons: string[]) => void;
  onSourceDisabled: (server: RegistryServerView) => void;
}) {
  const install = useRegistryInstall();
  return (
    <article className="flex flex-col gap-3 rounded-lg bg-surface p-[18px] shadow-card">
      <div className="min-w-0">
        <h3 className="m-0 truncate font-mono text-[14px] leading-[22px] font-semibold">
          {s.name}
        </h3>
        <p className="m-0 mt-0.5 text-caption text-muted">{s.description}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {s.runtimes.map((r) => (
          <Tag key={r}>{runtimeLabel(r)}</Tag>
        ))}
        <Tag tone="surface">
          {s.sourceName} · v{s.version}
        </Tag>
        {s.trust ? (
          <Tag tone={s.trust === 'official' ? 'ok' : s.trust === 'internal' ? 'info' : 'neutral'}>
            {TRUST_LABEL[s.trust] ?? s.trust}
          </Tag>
        ) : null}
      </div>
      <div className="mt-auto">
        {blocked ? (
          <Tag tone="bad">Blocked by registry policy</Tag>
        ) : s.requested ? (
          <Tag tone="info">Requested</Tag>
        ) : (
          <Button
            size="sm"
            disabled={install.isPending}
            onClick={() =>
              install.mutate(installToBody(s), {
                onSuccess: (result) => {
                  if (result.decision === 'needs-request') onNeedsRequest(result.reasons);
                  else toast.success(`${s.name} installed`);
                },
                onError: (err) => {
                  if (err instanceof ApiError && err.code === 'source_disabled') {
                    onSourceDisabled(s);
                  } else if (err instanceof ApiError && err.isForbidden) {
                    onBlocked();
                    toast.error(err.detail || 'Blocked by registry policy');
                  }
                },
              })
            }
          >
            Install
          </Button>
        )}
      </div>
    </article>
  );
}

function RejectDialog({
  request,
  onClose,
}: {
  request: InstallRequestView | null;
  onClose: () => void;
}) {
  const reject = useRejectRequest();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  return (
    <Dialog open={request !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Reject ${request?.serverName ?? ''}`}
        description="The person sees your reason."
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!request) return;
            const parsed = rejectFormSchema.safeParse({ reason });
            if (!parsed.success) return setError(fieldErrors(parsed.error).reason);
            setError(undefined);
            reject.mutate(
              { id: request.id, body: rejectToBody(parsed.data) },
              {
                onSuccess: () => {
                  toast.success('Rejected');
                  setReason('');
                  onClose();
                },
              },
            );
          }}
        >
          <Field label="Reason" required error={error}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={reject.isPending}>
            Reject request
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Requests() {
  const { role } = useAuth();
  const q = useInstallRequests('open');
  const approve = useApproveRequest();
  const [rejecting, setRejecting] = React.useState<InstallRequestView | null>(null);
  const canDecide = role === 'admin' || role === 'manager';
  return (
    <Card aria-label="Install requests" className="gap-2">
      <CardHeader title="Install requests" subtitle={canDecide ? 'Waiting for you' : 'Yours'} />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={<p className="m-0 py-3 text-muted">No open requests.</p>}
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <Avatar name={r.requesterName} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-label">
                    {r.requesterName} ·{' '}
                    <span className="font-mono text-[13px]">{r.serverName}</span>
                  </div>
                  <div className="text-caption text-muted">
                    {r.reason} · {r.teamName ?? 'No team'} · {formatRelative(r.createdAt)}
                  </div>
                </div>
                {canDecide ? (
                  <>
                    <Button
                      size="xs"
                      disabled={approve.isPending}
                      onClick={() =>
                        approve.mutate(r.id, { onSuccess: () => toast.success('Approved') })
                      }
                    >
                      Approve
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => setRejecting(r)}>
                      Reject
                    </Button>
                  </>
                ) : (
                  <Tag tone="info">Open</Tag>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <RejectDialog request={rejecting} onClose={() => setRejecting(null)} />
    </Card>
  );
}

type RuntimeFilter = 'all' | 'remote' | 'npm' | 'pypi';

const trustTone = (trust: string) =>
  trust === 'official' ? 'ok' : trust === 'internal' ? 'info' : 'neutral';

/** An install hit a source that is disabled: an admin is sent to the setting, everyone else to their admin. */
function SourceDisabledDialog({
  server,
  isAdmin,
  onClose,
}: {
  server: RegistryServerView | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={server !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="This registry source is disabled"
        description={
          isAdmin
            ? `${server?.sourceName ?? 'This source'} is switched off, so nothing can be installed from it. Enable it in Settings -> Registry.`
            : 'Ask your admin to enable this registry.'
        }
      >
        {isAdmin ? (
          <Button asChild>
            <Link to="/settings" search={{ section: 'registry' }} onClick={onClose}>
              Open Registry settings
            </Link>
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Which registries feed this screen: the enabled sources, when they last synced and how many entries they hold. */
function SourcesStrip({ isAdmin }: { isAdmin: boolean }) {
  const sources = useRegistrySources();
  const active = (sources.data ?? []).filter((s) => s.enabled);
  return (
    <section
      aria-label="Active registries"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-surface px-4 py-3 shadow-card"
    >
      {sources.isPending ? (
        <Skeleton className="h-5 w-64" />
      ) : active.length === 0 ? (
        <p className="m-0 text-muted">
          No registry is enabled.{' '}
          {isAdmin ? 'Enable one in Registry settings.' : 'Ask your admin to enable one.'}
        </p>
      ) : (
        active.map((src) => {
          const info = syncInfo(src);
          return (
            <div key={src.id} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-semibold">{src.name}</span>
              <Tag tone={trustTone(src.trust)}>{TRUST_LABEL[src.trust] ?? src.trust}</Tag>
              <span className="text-muted">
                {isSyncing(src)
                  ? 'syncing...'
                  : info
                    ? `${info.ok ? 'synced' : 'last sync failed'} ${formatRelative(info.finishedAt)} · ${info.fetched.toLocaleString()} entries`
                    : 'not synced yet'}
              </span>
            </div>
          );
        })
      )}
      {isAdmin ? (
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link to="/settings" search={{ section: 'registry' }}>
            <Settings className="size-4" aria-hidden="true" /> Registry settings
          </Link>
        </Button>
      ) : null}
    </section>
  );
}

const GRID = 'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]';

export function RegistryPage() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [sourceId, setSourceId] = React.useState('');
  const [runtime, setRuntime] = React.useState<RuntimeFilter>('all');
  const [requesting, setRequesting] = React.useState<Pending | null>(null);
  const [disabledSource, setDisabledSource] = React.useState<RegistryServerView | null>(null);
  const [blocked, setBlocked] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const sources = useRegistrySources();
  const enabledSources = (sources.data ?? []).filter((s) => s.enabled);
  const servers = useRegistryServers({
    q: debounced,
    sourceId,
    ...(runtime === 'all' ? {} : { runtime }),
  });
  const shown = servers.data?.servers.length ?? 0;
  return (
    <>
      <PageHeader
        title="Registry"
        subtitle="Browse external MCP registries. Your registry policy decides whether you install or request."
      />
      <SourcesStrip isAdmin={isAdmin} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-12 min-w-[260px] flex-1 items-center gap-2.5 rounded-md bg-surface px-4 shadow-card">
          <Search className="size-[18px] text-muted" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search registries"
            placeholder="Search registry servers"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
        </div>
        {enabledSources.length > 1 ? (
          <Select
            aria-label="Registry source"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-52"
          >
            <option value="">All sources</option>
            {enabledSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Segmented<RuntimeFilter>
          label="Runtime"
          value={runtime}
          onChange={setRuntime}
          options={[
            { value: 'all', label: 'All' },
            { value: 'remote', label: 'Remote' },
            { value: 'npm', label: 'npm' },
            { value: 'pypi', label: 'PyPI' },
          ]}
        />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <QueryBoundary
            query={servers}
            isEmpty={(d) => d.servers.length === 0}
            skeleton={
              <div className={GRID}>
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-40" />
                ))}
              </div>
            }
            empty={
              <EmptyState
                icon={<Globe />}
                title="No registry servers match"
                description={
                  enabledSources.length === 0
                    ? isAdmin
                      ? 'No registry is enabled. Enable one in Registry settings.'
                      : 'No registry is enabled. Ask your admin to enable one.'
                    : 'Try another name or a capability like “payments”, or sync the registry again.'
                }
                {...(debounced || sourceId || runtime !== 'all'
                  ? {
                      action: {
                        label: 'Clear filters',
                        onClick: () => {
                          setQ('');
                          setSourceId('');
                          setRuntime('all');
                        },
                      },
                    }
                  : {})}
              />
            }
          >
            {(data) => (
              <>
                <div className={GRID}>
                  {data.servers.map((s) => (
                    <ServerCard
                      key={serverKey(s)}
                      s={s}
                      blocked={blocked.has(serverKey(s))}
                      onBlocked={() => setBlocked((prev) => new Set(prev).add(serverKey(s)))}
                      onNeedsRequest={(reasons) => setRequesting({ server: s, reasons })}
                      onSourceDisabled={setDisabledSource}
                    />
                  ))}
                  {servers.isFetchingNextPage
                    ? Array.from({ length: 3 }, (_, i) => (
                        <Skeleton key={`next-${i}`} className="h-40" />
                      ))
                    : null}
                </div>
                <div className="flex items-center justify-center gap-3 text-caption text-muted">
                  <span>{shown} shown</span>
                  {servers.hasNextPage ? (
                    <Button
                      variant="outline"
                      disabled={servers.isFetchingNextPage}
                      onClick={() => void servers.fetchNextPage()}
                    >
                      Load more
                    </Button>
                  ) : (
                    <span>End of results</span>
                  )}
                </div>
              </>
            )}
          </QueryBoundary>
        </div>
        <Requests />
      </div>
      <RequestDialog pending={requesting} onClose={() => setRequesting(null)} />
      <SourceDisabledDialog
        server={disabledSource}
        isAdmin={isAdmin}
        onClose={() => setDisabledSource(null)}
      />
    </>
  );
}
