import { Globe, Search } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import {
  useApproveRequest,
  useCreateInstallRequest,
  useInstallRequests,
  useRegistryInstall,
  useRegistryServers,
  useRejectRequest,
} from '@/api/hooks';
import {
  type InstallRequestView,
  type RegistryServerView,
  reasonsText,
  runtimeLabel,
  serverKey,
} from '@/api/views/registry';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { Avatar, Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
}: {
  s: RegistryServerView;
  blocked: boolean;
  onBlocked: () => void;
  onNeedsRequest: (reasons: string[]) => void;
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
                  if (err instanceof ApiError && err.isForbidden) {
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

export function RegistryPage() {
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [requesting, setRequesting] = React.useState<Pending | null>(null);
  const [blocked, setBlocked] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const servers = useRegistryServers(debounced);
  return (
    <>
      <PageHeader
        title="Registry"
        subtitle="Browse external MCP registries. Your registry policy decides whether you install or request."
      />
      <div className="flex h-12 items-center gap-2.5 rounded-md bg-surface px-4 shadow-card">
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
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <QueryBoundary
          query={servers}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              icon={<Globe />}
              title="No registry servers match"
              description="Try another name or a capability like “payments”."
              action={{ label: 'Clear search', onClick: () => setQ('') }}
            />
          }
        >
          {(items) => (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
              {items.map((s) => (
                <ServerCard
                  key={serverKey(s)}
                  s={s}
                  blocked={blocked.has(serverKey(s))}
                  onBlocked={() => setBlocked((prev) => new Set(prev).add(serverKey(s)))}
                  onNeedsRequest={(reasons) => setRequesting({ server: s, reasons })}
                />
              ))}
            </div>
          )}
        </QueryBoundary>
        <Requests />
      </div>
      <RequestDialog pending={requesting} onClose={() => setRequesting(null)} />
    </>
  );
}
