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
  useToolCounts,
} from '@/api/hooks';
import {
  defaultEndpointUrl,
  type EndpointValues,
  type EndpointView,
  endpointUrl,
  type InstallationView,
  toEndpointBody,
  toEndpointPatch,
} from '@/api/views/servers';
import { useAuth } from '@/auth/auth';
import { ClientConfigTabs } from '@/components/client-config';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { useSlug } from '@/features/access/forms';

/** The constraints of `endpointCreateSchema`: slug 2 to 40 of a-z 0-9 and dashes, name 1 to 200, 50 servers. */
export const endpointFormSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'Give the endpoint a name')
    .max(200, 'Up to 200 characters'),
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Use 2 to 40 lowercase letters, digits and dashes'),
  installationIds: z.array(z.string()).min(1, 'Pick at least one server').max(50, 'At most 50'),
  prefixMode: z.enum(['always', 'onCollision']),
  instructions: z.string().max(8000, 'Up to 8000 characters'),
});

export function ToolCountWarning({ count, threshold }: { count: number; threshold: number }) {
  if (count <= threshold) return null;
  return (
    <p
      role="status"
      className="m-0 flex items-start gap-2 rounded-md bg-tangerine-soft p-3 text-[13px] text-tangerine-ink"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {count} tools is a lot: past {threshold}, AI tools get slower and pick the wrong tool more
        often. Remove a server you do not need here.
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
  endpoint: EndpointView | null;
  installations: InstallationView[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { me } = useAuth();
  const create = useCreateEndpoint();
  const patch = usePatchEndpoint(endpoint?.id ?? '');
  const initial = (): EndpointValues => ({
    displayName: endpoint?.displayName ?? '',
    slug: endpoint?.slug ?? '',
    installationIds: endpoint?.installationIds ?? [],
    prefixMode: endpoint?.prefixMode ?? 'always',
    instructions: endpoint?.instructions ?? '',
  });
  const form = useForm<EndpointValues>({
    resolver: zodResolver(endpointFormSchema),
    defaultValues: initial(),
  });
  const displayName = form.watch('displayName');
  const url = useSlug(displayName);
  // A new endpoint's URL name follows its name until the user edits it; an existing one keeps its own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens or its endpoint changes
  React.useEffect(() => {
    if (open) {
      form.reset(initial());
      url.reset();
    }
  }, [open, endpoint]);
  React.useEffect(() => {
    if (!endpoint) form.setValue('slug', url.slug, { shouldValidate: form.formState.isSubmitted });
  }, [endpoint, url.slug, form]);
  const ids = form.watch('installationIds');
  const counts = useToolCounts(ids);
  const tools = ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0);
  const [error, setError] = React.useState<unknown>(null);
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      if (endpoint) {
        await patch.mutateAsync({ patch: toEndpointPatch(v), updatedAt: endpoint.updatedAt });
      } else await create.mutateAsync(toEndpointBody(v));
      toast.success(endpoint ? 'Endpoint saved' : 'Endpoint created');
      onOpenChange(false);
    } catch (e) {
      setError(e);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={endpoint ? `Edit ${endpoint.name}` : 'New endpoint'}
        description="A named endpoint carries only the servers you pick."
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Name" required error={form.formState.errors.displayName?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('displayName')}
              />
            )}
          </Field>
          <Field
            label="URL name"
            required
            help={`Its address is ${endpointUrl(me.org.baseUrl, form.watch('slug') || '…')}`}
            error={form.formState.errors.slug?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('slug', { onChange: (e) => url.setSlug(e.target.value) })}
              />
            )}
          </Field>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1.5 text-[13px] font-medium">Servers</legend>
            {installations.map((i) => (
              <label
                key={i.id}
                className="flex min-h-10 items-center gap-2.5 rounded-md px-2 hover:bg-sunken"
              >
                <Checkbox
                  checked={ids.includes(i.id)}
                  onCheckedChange={(c) =>
                    form.setValue(
                      'installationIds',
                      c ? [...ids, i.id] : ids.filter((x) => x !== i.id),
                      { shouldValidate: true },
                    )
                  }
                />
                <span className="flex-1 text-label">{i.displayName}</span>
                {counts.has(i.id) ? (
                  <span className="text-caption text-muted">{counts.get(i.id)} tools</span>
                ) : null}
              </label>
            ))}
            {form.formState.errors.installationIds ? (
              <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                {form.formState.errors.installationIds.message}
              </p>
            ) : null}
          </fieldset>
          <ToolCountWarning count={tools} threshold={me.org.toolWarnThreshold} />
          <Field
            label="Tool names"
            help="Prefix every tool with its server, or only when two servers share a name."
          >
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} {...form.register('prefixMode')}>
                <option value="always">Always prefix with the server</option>
                <option value="onCollision">Prefix only when names collide</option>
              </Select>
            )}
          </Field>
          <Field
            label="Instructions"
            help="Optional text AI tools receive with this endpoint."
            error={form.formState.errors.instructions?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="min-h-20"
                {...form.register('instructions')}
              />
            )}
          </Field>
          {error ? <ProblemAlert error={error} /> : null}
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
  const [editing, setEditing] = React.useState<EndpointView | null | 'new'>(null);
  const [config, setConfig] = React.useState<EndpointView | null>(null);
  const items = installs.data ?? [];
  const all = React.useMemo(() => items.map((i) => i.id), [items]);
  const counts = useToolCounts(all);
  const toolsOf = (ids: readonly string[]) => ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="m-0 flex-1 text-muted">
          An endpoint is one URL for your AI tools. The default endpoint carries every server you
          have set up and is the one to use. Add a named endpoint to give a client only some servers
          (a client with many tools can pick the right one more reliably from a short list).
        </p>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden="true" />
          New endpoint
        </Button>
      </div>
      <Card aria-label="Default endpoint">
        <CardHeader title="Default endpoint" actions={<Tag tone="info">Default</Tag>} />
        <CopyField
          value={defaultEndpointUrl(me.org.baseUrl)}
          label="Default endpoint URL"
          tone="sunken"
        />
        <ToolCountWarning
          count={toolsOf(items.filter((i) => i.enabled).map((i) => i.id))}
          threshold={me.org.toolWarnThreshold}
        />
        <p className="m-0 text-caption text-muted">
          For a step-by-step client setup, use a named endpoint below.
        </p>
      </Card>
      <QueryBoundary
        query={endpoints}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<Network />}
            title="No named endpoints yet"
            description="Create one to give an AI tool only the servers you pick."
            action={{ label: 'New endpoint', onClick: () => setEditing('new') }}
          />
        }
      >
        {(list) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {list.map((e) => (
              <Card key={e.id} aria-label={e.name}>
                <CardHeader title={e.name} />
                <CopyField value={e.url} label={`${e.name} URL`} tone="sunken" />
                <div className="flex flex-wrap gap-1.5">
                  {e.installationIds.map((id) => {
                    const i = items.find((x) => x.id === id);
                    return <Chip key={id}>{i?.displayName ?? id}</Chip>;
                  })}
                </div>
                <ToolCountWarning
                  count={toolsOf(e.installationIds)}
                  threshold={me.org.toolWarnThreshold}
                />
                <div className="flex gap-2">
                  <Button variant="soft" size="sm" onClick={() => setConfig(e)}>
                    Client setup
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(e)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      del.mutate(
                        { id: e.id, updatedAt: e.updatedAt },
                        { onSuccess: () => toast.success('Endpoint removed') },
                      )
                    }
                  >
                    Remove
                  </Button>
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
