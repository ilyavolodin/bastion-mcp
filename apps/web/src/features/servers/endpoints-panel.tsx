import { zodResolver } from '@hookform/resolvers/zod';
import { Network, Plus, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  useCreateEndpoint,
  useDeleteEndpoint,
  useEndpoints,
  useInstallations,
  usePatchEndpoint,
} from '@/api/hooks';
import type { Endpoint, Installation } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { ClientConfigTabs } from '@/components/client-config';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const schema = z.object({
  name: z.string().trim().min(1, 'Give the endpoint a name').max(60, 'Keep it under 60 characters'),
  installationIds: z.array(z.string()).min(1, 'Pick at least one server'),
});
type Values = z.infer<typeof schema>;

export function ToolCountWarning({ count, threshold }: { count: number; threshold: number }) {
  if (count <= threshold) return null;
  return (
    <p role="status" className="m-0 flex items-start gap-2 rounded-md bg-tangerine-soft p-3 text-[13px] text-tangerine-ink">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {count} tools is a lot: past {threshold}, AI tools get slower and pick the wrong tool more often. Remove a server
        you do not need here.
      </span>
    </p>
  );
}

function EndpointDialog({
  endpoint,
  installations,
  open,
  onOpenChange,
}: {
  endpoint: Endpoint | null;
  installations: Installation[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { me } = useAuth();
  const create = useCreateEndpoint();
  const patch = usePatchEndpoint(endpoint?.id ?? '');
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: endpoint?.name ?? '', installationIds: endpoint?.installationIds ?? [] },
  });
  React.useEffect(() => {
    if (open) form.reset({ name: endpoint?.name ?? '', installationIds: endpoint?.installationIds ?? [] });
  }, [open, endpoint, form]);
  const ids = form.watch('installationIds');
  const tools = installations.filter((i) => ids.includes(i.id)).reduce((n, i) => n + i.toolCount, 0);
  const submit = form.handleSubmit(async (v) => {
    if (endpoint) await patch.mutateAsync(v);
    else await create.mutateAsync(v);
    toast.success(endpoint ? 'Endpoint saved' : 'Endpoint created');
    onOpenChange(false);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={endpoint ? `Edit ${endpoint.name}` : 'New endpoint'} description="A named endpoint carries only the servers you pick.">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Name" required error={form.formState.errors.name?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />
            )}
          </Field>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1.5 text-[13px] font-medium">Servers</legend>
            {installations.map((i) => (
              <label key={i.id} className="flex min-h-10 items-center gap-2.5 rounded-md px-2 hover:bg-sunken">
                <Checkbox
                  checked={ids.includes(i.id)}
                  onCheckedChange={(c) =>
                    form.setValue('installationIds', c ? [...ids, i.id] : ids.filter((x) => x !== i.id), { shouldValidate: true })
                  }
                />
                <span className="flex-1 text-label">{i.displayName}</span>
                <span className="text-caption text-muted">{i.toolCount} tools</span>
              </label>
            ))}
            {form.formState.errors.installationIds ? (
              <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                {form.formState.errors.installationIds.message}
              </p>
            ) : null}
          </fieldset>
          <ToolCountWarning count={tools} threshold={me.org.toolWarnThreshold} />
          <Button type="submit" disabled={create.isPending || patch.isPending}>
            {endpoint ? 'Save endpoint' : 'Create endpoint'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Endpoints management: the default endpoint and named subsets, with client configs. */
export function EndpointsPanel() {
  const { me } = useAuth();
  const endpoints = useEndpoints();
  const installs = useInstallations();
  const del = useDeleteEndpoint();
  const [editing, setEditing] = React.useState<Endpoint | null | 'new'>(null);
  const [config, setConfig] = React.useState<Endpoint | null>(null);
  const items = installs.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="m-0 flex-1 text-muted">Each endpoint is one URL for your AI tools. The default carries everything you have set up.</p>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden="true" />
          New endpoint
        </Button>
      </div>
      <QueryBoundary
        query={endpoints}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon={<Network />} title="No endpoints yet" description="Install a server and your default endpoint appears." action={{ label: 'Browse the store', to: '/store' }} />}
      >
        {(list) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {list.map((e) => (
              <Card key={e.id} aria-label={e.name}>
                <CardHeader title={e.name} actions={e.isDefault ? <Tag tone="info">Default</Tag> : undefined} />
                <CopyField value={e.url} label={`${e.name} URL`} tone="sunken" />
                <div className="flex flex-wrap gap-1.5">
                  {e.installationIds.map((id) => {
                    const i = items.find((x) => x.id === id);
                    return <Chip key={id}>{i?.displayName ?? id}</Chip>;
                  })}
                </div>
                <ToolCountWarning count={e.toolCount} threshold={me.org.toolWarnThreshold} />
                <div className="flex gap-2">
                  <Button variant="soft" size="sm" onClick={() => setConfig(e)}>
                    Client setup
                  </Button>
                  {!e.isDefault ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setEditing(e)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => del.mutate(e.id, { onSuccess: () => toast.success('Endpoint removed') })}>
                        Remove
                      </Button>
                    </>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>
      <EndpointDialog
        endpoint={editing === 'new' ? null : editing}
        installations={items}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <Dialog open={config !== null} onOpenChange={(o) => !o && setConfig(null)}>
        <DialogContent title={`Add ${config?.name ?? ''} to a client`} className="sm:max-w-xl">
          <ClientConfigTabs endpointId={config?.id} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
