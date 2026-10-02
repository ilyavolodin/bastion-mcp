import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import {
  useCreateRegistrySource,
  useDeleteRegistrySource,
  usePatchRegistrySource,
  usePutRegistryPolicy,
  useRegistryPolicy,
  useRegistrySources,
  useSyncRegistrySource,
} from '@/api/hooks';
import {
  isSyncing,
  markSyncRequested,
  type RegistrySource,
  syncInfo,
  TRUST_LABEL,
} from '@/api/views/registry';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatRelative } from '@/lib/format';

const PRESETS = [
  {
    key: 'github',
    label: 'GitHub MCP registry',
    name: 'GitHub MCP Registry',
    baseUrl: 'https://api.mcp.github.com',
    trust: 'community',
  },
] as const;

const problemText = (error: unknown): string =>
  error instanceof ApiError
    ? [error.detail || error.title, ...error.errors.map((e) => e.message)].join(': ')
    : error instanceof Error
      ? error.message
      : 'The request failed';

// --- add source -----------------------------------------------------------------------------------------------

function AddSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateRegistrySource();
  const empty = {
    name: '',
    baseUrl: '',
    authHeaderName: '',
    authSecretId: '',
    trust: 'community',
    syncIntervalS: '3600',
  };
  const [v, setV] = React.useState(empty);
  const [error, setError] = React.useState<string | undefined>();
  const set = (patch: Partial<typeof empty>) => setV((prev) => ({ ...prev, ...patch }));
  const interval = Number(v.syncIntervalS);
  const invalidInterval = !Number.isInteger(interval) || interval < 60 || interval > 7 * 86400;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setError(undefined);
          onClose();
        }
      }}
    >
      <DialogContent
        title="Add a registry source"
        description="Any registry that implements the MCP registry API v0.1. The URL must be https and reachable from the server."
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!v.name.trim()) return setError('Name the source');
            if (!v.baseUrl.trim()) return setError('Give the base URL');
            if (invalidInterval) return setError('Sync interval: 60 seconds to 7 days');
            setError(undefined);
            create.mutate(
              {
                name: v.name.trim(),
                baseUrl: v.baseUrl.trim(),
                trust: v.trust as 'official' | 'internal' | 'community',
                // A new source is switched on only by the admin, after looking at the policy.
                enabled: false,
                syncIntervalS: interval,
                authSecretId: v.authSecretId.trim() || null,
                authHeaderName: v.authHeaderName.trim() || null,
              },
              {
                onSuccess: () => {
                  toast.success('Registry source added (disabled)');
                  setV(empty);
                  onClose();
                },
                onError: (err) => setError(problemText(err)),
              },
            );
          }}
        >
          <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => set({ name: p.name, baseUrl: p.baseUrl, trust: p.trust })}
              >
                Use {p.label}
              </Button>
            ))}
          </div>
          <Field label="Name" required>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={v.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Base URL" required help="For example https://registry.example.com">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={v.baseUrl}
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trust level">
              {({ id }) => (
                <Select id={id} value={v.trust} onChange={(e) => set({ trust: e.target.value })}>
                  <option value="community">Community (risk medium)</option>
                  <option value="internal">Internal</option>
                  <option value="official">Official</option>
                </Select>
              )}
            </Field>
            <Field label="Sync interval (seconds)">
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  value={v.syncIntervalS}
                  onChange={(e) => set({ syncIntervalS: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Auth header name" help="Optional, default Authorization">
              {({ id }) => (
                <Input
                  id={id}
                  value={v.authHeaderName}
                  onChange={(e) => set({ authHeaderName: e.target.value })}
                />
              )}
            </Field>
            <Field label="Auth secret" help="Optional: id of a stored secret">
              {({ id }) => (
                <Input
                  id={id}
                  value={v.authSecretId}
                  onChange={(e) => set({ authSecretId: e.target.value })}
                />
              )}
            </Field>
          </div>
          {error ? (
            <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={create.isPending}>
            Add source
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- policy -----------------------------------------------------------------------------------------------------

const RISKS = ['low', 'medium', 'high'] as const;
const RUNTIMES = ['remote', 'npm', 'pypi'] as const;
const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function PolicyDialog({ source, onClose }: { source: RegistrySource | null; onClose: () => void }) {
  const policy = useRegistryPolicy(source?.id ?? '', source !== null);
  const put = usePutRegistryPolicy();
  const [form, setForm] = React.useState<null | {
    allowed: string;
    blocked: string;
    runtimes: string[];
    who: string;
    mode: string;
    osv: boolean;
    risk: string;
  }>(null);
  const [error, setError] = React.useState<string | undefined>();
  React.useEffect(() => {
    const p = policy.data?.policy;
    if (!p) return;
    setForm({
      allowed: p.allowedNamespaces.join('\n'),
      blocked: p.blockedNamespaces.join('\n'),
      runtimes: [...p.allowedRuntimes],
      who: p.whoMayInstall,
      mode: p.mode,
      osv: p.requireOsvClean,
      risk: p.maxRisk,
    });
  }, [policy.data]);
  return (
    <Dialog open={source !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Install policy: ${source?.name ?? ''}`}
        description="Decides what happens when someone presses Install on a server of this registry."
        className="max-w-xl"
      >
        {!form ? (
          <p className="m-0 text-muted">
            {policy.isError ? 'The policy could not be loaded.' : 'Loading...'}
          </p>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!source) return;
              if (form.runtimes.length === 0) return setError('Allow at least one runtime');
              setError(undefined);
              put.mutate(
                {
                  sourceId: source.id,
                  body: {
                    allowedNamespaces: lines(form.allowed).length > 0 ? lines(form.allowed) : ['*'],
                    blockedNamespaces: lines(form.blocked),
                    allowedRuntimes: form.runtimes as ('remote' | 'npm' | 'pypi')[],
                    whoMayInstall: form.who as 'admins' | 'managers' | 'everyone',
                    mode: form.mode as 'direct' | 'request' | 'catalogOnly',
                    requireOsvClean: form.osv,
                    maxRisk: form.risk as 'low' | 'medium' | 'high',
                  },
                },
                {
                  onSuccess: () => {
                    toast.success('Policy saved');
                    onClose();
                  },
                  onError: (err) => setError(problemText(err)),
                },
              );
            }}
          >
            <Field
              label="Mode"
              help="Direct installs at once, request asks a manager or admin, catalog only imports into the catalog."
            >
              {({ id }) => (
                <Select
                  id={id}
                  value={form.mode}
                  onChange={(e) => setForm({ ...form, mode: e.target.value })}
                >
                  <option value="direct">Direct: install at once</option>
                  <option value="request">Request: a manager or admin approves</option>
                  <option value="catalogOnly">Catalog only: import, never install</option>
                </Select>
              )}
            </Field>
            <Field label="Who may install">
              {({ id }) => (
                <Select
                  id={id}
                  value={form.who}
                  onChange={(e) => setForm({ ...form, who: e.target.value })}
                >
                  <option value="admins">Admins</option>
                  <option value="managers">Managers and admins</option>
                  <option value="everyone">Everyone</option>
                </Select>
              )}
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 text-[13px] font-medium">Allowed runtimes</legend>
              <div className="flex flex-wrap gap-4">
                {RUNTIMES.map((r) => (
                  <label key={r} className="flex items-center gap-2 text-label">
                    <input
                      type="checkbox"
                      checked={form.runtimes.includes(r)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          runtimes: e.target.checked
                            ? [...form.runtimes, r]
                            : form.runtimes.filter((x) => x !== r),
                        })
                      }
                    />
                    {r === 'pypi' ? 'PyPI' : r === 'npm' ? 'npm' : 'Remote'}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field
              label="Allowed namespaces"
              help="One pattern per line, for example io.github.acme/*. * allows all."
            >
              {({ id }) => (
                <textarea
                  id={id}
                  rows={3}
                  value={form.allowed}
                  onChange={(e) => setForm({ ...form, allowed: e.target.value })}
                  className="rounded-md border border-line-strong bg-surface p-2 font-mono text-[13px]"
                />
              )}
            </Field>
            <Field
              label="Blocked namespaces"
              help="One pattern per line. Blocked wins over allowed."
            >
              {({ id }) => (
                <textarea
                  id={id}
                  rows={3}
                  value={form.blocked}
                  onChange={(e) => setForm({ ...form, blocked: e.target.value })}
                  className="rounded-md border border-line-strong bg-surface p-2 font-mono text-[13px]"
                />
              )}
            </Field>
            <Field
              label="Highest risk installed directly"
              help="Above this, a direct install turns into a request."
            >
              {({ id }) => (
                <Select
                  id={id}
                  value={form.risk}
                  onChange={(e) => setForm({ ...form, risk: e.target.value })}
                >
                  {RISKS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <label className="flex items-center gap-3">
              <Switch
                checked={form.osv}
                onCheckedChange={(v) => setForm({ ...form, osv: v })}
                aria-label="Require OSV clean"
              />
              <span className="text-label">Require a clean OSV malware check</span>
            </label>
            {error ? (
              <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={put.isPending}>
              Save policy
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- one source ------------------------------------------------------------------------------------------------

function SourceRow({
  source,
  onPolicy,
}: {
  source: RegistrySource;
  onPolicy: (s: RegistrySource) => void;
}) {
  const patch = usePatchRegistrySource();
  const sync = useSyncRegistrySource();
  const remove = useDeleteRegistrySource();
  const info = syncInfo(source);
  const syncing = isSyncing(source);
  const start = (full: boolean) => {
    markSyncRequested(source.id);
    sync.mutate(
      { id: source.id, full },
      {
        onSuccess: () => toast.success('Sync started'),
        onError: (err) => toast.error(problemText(err)),
      },
    );
  };
  return (
    <li
      aria-label={source.name}
      className="flex flex-col gap-3 border-b border-line py-4 first:pt-1 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label font-semibold">{source.name}</span>
            <Tag
              tone={
                source.trust === 'official'
                  ? 'ok'
                  : source.trust === 'internal'
                    ? 'info'
                    : 'neutral'
              }
            >
              {TRUST_LABEL[source.trust] ?? source.trust}
            </Tag>
            <Tag tone={source.enabled ? 'ok' : 'warn'}>
              {source.enabled ? 'Enabled' : 'Disabled'}
            </Tag>
          </div>
          <div className="truncate font-mono text-[12px] text-muted">{source.baseUrl}</div>
        </div>
        <label className="flex items-center gap-2 text-label">
          <Switch
            checked={source.enabled}
            disabled={patch.isPending}
            aria-label={`Enable ${source.name}`}
            onCheckedChange={(enabled) => {
              if (enabled) markSyncRequested(source.id);
              patch.mutate(
                { id: source.id, version: source.updatedAt, body: { enabled } },
                {
                  onSuccess: () =>
                    toast.success(
                      enabled
                        ? `${source.name} enabled, first sync started`
                        : `${source.name} disabled`,
                    ),
                  onError: (err) => toast.error(problemText(err)),
                },
              );
            }}
          />
          Enabled
        </label>
      </div>
      <p className="m-0 text-caption text-muted" aria-live="polite">
        {syncing
          ? 'Syncing...'
          : info
            ? info.ok
              ? `Last sync ${formatRelative(info.finishedAt)}: ${info.fetched.toLocaleString()} entries (${info.pages} pages${info.invalid ? `, ${info.invalid} skipped as invalid` : ''}${info.deprecated ? `, ${info.deprecated} deprecated` : ''}).`
              : `Last sync ${formatRelative(info.finishedAt)} failed: ${info.error ?? 'unknown error'}. ${info.fetched.toLocaleString()} entries were mirrored before it stopped.`
            : source.enabled
              ? 'Not synced yet.'
              : 'Enable the source to mirror its servers.'}{' '}
        Every {Math.round(source.syncIntervalS / 60)} min.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!source.enabled || syncing || sync.isPending}
          onClick={() => start(false)}
        >
          Sync now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!source.enabled || syncing || sync.isPending}
          onClick={() => start(true)}
        >
          Full re-sync
        </Button>
        <Button size="sm" variant="outline" onClick={() => onPolicy(source)}>
          Install policy
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={remove.isPending}
          onClick={() => {
            if (!window.confirm(`Remove ${source.name} and its mirrored servers?`)) return;
            remove.mutate(
              { id: source.id, version: source.updatedAt },
              { onError: (err) => toast.error(problemText(err)) },
            );
          }}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export function RegistrySection() {
  const sources = useRegistrySources();
  const [adding, setAdding] = React.useState(false);
  const [policyOf, setPolicyOf] = React.useState<RegistrySource | null>(null);
  return (
    <Card aria-label="Registry sources" className="gap-2">
      <CardHeader
        title="Registry sources"
        subtitle="Where the Registry screen gets its servers"
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            Add source
          </Button>
        }
      />
      <p className="m-0 text-muted">
        A source is mirrored into Bastion on a schedule; people browse and install from the mirror.
        Sources start disabled: enabling one starts its first sync, and its install policy decides
        who can install what.
      </p>
      <QueryBoundary
        query={sources}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No registry sources"
            description="Add one to let people browse MCP servers."
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((s) => (
              <SourceRow key={s.id} source={s} onPolicy={setPolicyOf} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <AddSourceDialog open={adding} onClose={() => setAdding(false)} />
      <PolicyDialog source={policyOf} onClose={() => setPolicyOf(null)} />
    </Card>
  );
}
