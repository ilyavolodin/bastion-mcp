import { Globe, Search } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useCreateInstallRequest,
  useDecideRequest,
  useInstallRequests,
  useRegistryInstall,
  useRegistryServers,
} from '@/api/hooks';
import type { RegistryServer } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { Avatar, Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { AUTH_LABEL, formatRelative, RUNTIME_LABEL } from '@/lib/format';

function RequestDialog({
  server,
  onClose,
}: {
  server: RegistryServer | null;
  onClose: () => void;
}) {
  const create = useCreateInstallRequest();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  return (
    <Dialog open={server !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Request ${server?.name ?? ''}`}
        description="A manager or admin reviews the request before it is installed."
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!server) return;
            if (!reason.trim()) return setError('Say what you need it for');
            create.mutate(
              { sourceId: server.sourceId, name: server.name, version: server.version, reason },
              {
                onSuccess: () => {
                  toast.success('Request sent');
                  setReason('');
                  onClose();
                },
              },
            );
          }}
        >
          <Field label="What do you need it for?" required error={error}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
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

function ServerCard({ s, onRequest }: { s: RegistryServer; onRequest: () => void }) {
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
        <Tag>{RUNTIME_LABEL[s.runtime]}</Tag>
        <Tag tone={s.authMode === 'oauth' ? 'warn' : 'ok'}>{AUTH_LABEL[s.authMode]}</Tag>
        <Tag tone="surface">
          {s.sourceName} · v{s.version}
        </Tag>
      </div>
      <div className="mt-auto">
        {s.policy === 'allowed' ? (
          <Button
            size="sm"
            disabled={install.isPending}
            onClick={() =>
              install.mutate(
                { sourceId: s.sourceId, name: s.name, version: s.version },
                { onSuccess: () => toast.success(`${s.name} installed`) },
              )
            }
          >
            Install
          </Button>
        ) : s.policy === 'request' ? (
          s.requested ? (
            <Tag tone="info">Requested</Tag>
          ) : (
            <Button size="sm" variant="soft" onClick={onRequest}>
              Request install
            </Button>
          )
        ) : (
          <Tag tone="bad">Blocked by registry policy</Tag>
        )}
      </div>
    </article>
  );
}

function Requests() {
  const { role } = useAuth();
  const q = useInstallRequests('open');
  const decide = useDecideRequest();
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
                      onClick={() =>
                        decide.mutate(
                          { id: r.id, decision: 'approve' },
                          { onSuccess: () => toast.success('Approved') },
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        decide.mutate(
                          { id: r.id, decision: 'reject' },
                          { onSuccess: () => toast.success('Rejected') },
                        )
                      }
                    >
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
    </Card>
  );
}

export function RegistryPage() {
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [requesting, setRequesting] = React.useState<RegistryServer | null>(null);
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
                  key={`${s.sourceId}-${s.name}`}
                  s={s}
                  onRequest={() => setRequesting(s)}
                />
              ))}
            </div>
          )}
        </QueryBoundary>
        <Requests />
      </div>
      <RequestDialog server={requesting} onClose={() => setRequesting(null)} />
    </>
  );
}
