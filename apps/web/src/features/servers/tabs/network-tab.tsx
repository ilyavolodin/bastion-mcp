import { Ban, Globe, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useEgress, useRequestEgress } from '@/api/hooks';
import type { Installation } from '@/api/types';
import { Field } from '@/components/form';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

/** Allowed and denied egress hosts as chips with a badge, plus "request access" (18.3, 8.8). */
export function NetworkTab({ installation: i }: { installation: Installation }) {
  const q = useEgress(i.id);
  const request = useRequestEgress(i.id);
  const [open, setOpen] = React.useState(false);
  const [host, setHost] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[a-z0-9*]([a-z0-9.*-]*[a-z0-9])?$/i.test(host.trim())) return setError('Enter a host name like api.example.com');
    request.mutate({ host: host.trim(), reason }, { onSuccess: () => { toast.success('Request sent to an admin'); setOpen(false); setHost(''); setReason(''); setError(undefined); } });
  };
  return (
    <QueryBoundary query={q}>
      {(d) => (
        <div className="flex flex-col gap-6">
          <Card aria-label="Egress hosts" className="gap-4">
            <CardHeader title="Where this server can connect" actions={<Button variant="outline" size="sm" onClick={() => setOpen(true)}>Request access</Button>} />
            {d.hosts.length === 0 ? (
              <p className="m-0 text-muted">This server has not tried to reach anything outside Bastion.</p>
            ) : (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {d.hosts.map((h) => (
                  <li key={h.host} title={h.reason} className={cn('inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] font-medium', h.status === 'allowed' ? 'bg-sunken' : 'bg-coral-soft text-coral-ink')}>
                    <Globe className="size-3.5" aria-hidden="true" />
                    {h.host}
                    <Tag tone={h.status === 'allowed' ? 'ok' : 'bad'} icon={h.status === 'allowed' ? <ShieldCheck className="size-3" aria-hidden="true" /> : <Ban className="size-3" aria-hidden="true" />}>
                      {h.status === 'allowed' ? 'Allowed' : 'Denied'}
                    </Tag>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {d.requests.length > 0 ? (
            <Card aria-label="Access requests" className="gap-2">
              <CardHeader title="Waiting for an admin" />
              {d.requests.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[13px]">
                  <Tag tone="warn">{r.status}</Tag>
                  <span className="font-mono">{r.host}</span>
                  <span className="text-muted">{r.reason}</span>
                </div>
              ))}
            </Card>
          ) : null}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent title="Request network access" description="An admin reviews the host before it is allowed.">
              <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Host" required error={error} help="Exact host or *.example.com">
                  {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} value={host} onChange={(e) => setHost(e.target.value)} />}
                </Field>
                <Field label="Why does it need this?">
                  {({ id }) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}
                </Field>
                <Button type="submit" disabled={request.isPending}>Send request</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </QueryBoundary>
  );
}
