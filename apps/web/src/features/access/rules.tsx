import { Check, Lock, Play, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import {
  useCustomPolicies,
  useDeleteCustomPolicy,
  useDeletePolicyRule,
  useInstallations,
  usePolicyRules,
  useSaveCustomPolicy,
  useSavePolicyRule,
  useServiceAccounts,
  useSimulate,
  useTeams,
  useUsers,
  useValidatePolicy,
} from '@/api/hooks';
import type { Body, PolicyEffect, Res, Schemas } from '@/api/schema';
import {
  addTo,
  type Chip as ChipData,
  type RuleLookups,
  type RuleWhat,
  type RuleWhen,
  type RuleWho,
  removeWhat,
  removeWhen,
  removeWho,
  ruleScopeLabel,
  whatChips,
  whenChips,
  whoChips,
} from '@/api/views/access';
import { useAuth } from '@/auth/auth';
import { CodeEditor } from '@/components/code-editor';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Avatar, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { CEDAR_SAMPLE_NEW } from './cedar-sample';
import {
  buildPolicyTest,
  CIDR,
  fieldErrors,
  type PolicyTest,
  policyFormSchema,
  ruleFormSchema,
  serverFieldErrors,
  TEST_ACTIONS,
  toMarkers,
} from './forms';

const EFFECT = {
  permit: { label: 'Permit', cls: 'bg-mint-soft text-mint-ink' },
  forbid: { label: 'Forbid', cls: 'bg-coral-soft text-coral-ink' },
} as const;

type PolicyRule = Schemas['PolicyRule'];
type CustomPolicy = Schemas['CustomPolicy'];

/** Everything the rule chips need to name teams, people, accounts and servers. */
function useRuleLookups(): RuleLookups {
  const teams = useTeams();
  const users = useUsers({});
  const accounts = useServiceAccounts();
  const installs = useInstallations();
  return {
    teams: teams.data ?? [],
    users: users.data ?? [],
    serviceAccounts: (accounts.data ?? []).map((a) => ({ id: a.id, name: a.displayName })),
    installations: installs.data ?? [],
  };
}

function Row({
  label,
  chips,
  mono,
  tone,
}: {
  label: string;
  chips: ChipData[];
  mono?: boolean;
  tone?: 'info' | 'berry';
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[42px] text-[11px] font-semibold text-muted">{label}</span>
      {chips.map((c) => (
        <span
          key={c.key}
          className={cn(
            'inline-flex h-6 items-center rounded-sm px-2 text-caption font-medium',
            tone === 'info' && 'bg-sky-soft text-sky-ink',
            tone === 'berry' && 'bg-berry-soft text-berry-ink',
            !tone && 'bg-sunken',
            mono && 'font-mono',
          )}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function RuleRow({
  rule,
  lookups,
  canEdit,
  onEdit,
  onDelete,
}: {
  rule: PolicyRule;
  lookups: RuleLookups;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const e = EFFECT[rule.effect];
  return (
    <li
      className={cn(
        'grid grid-cols-[76px_minmax(0,1fr)_150px] items-center gap-3.5 rounded-md border border-line p-3.5 max-md:grid-cols-1',
        !canEdit && 'bg-sunken',
        !rule.enabled && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'inline-flex h-[26px] items-center justify-center gap-1 rounded-sm text-caption font-semibold',
          e.cls,
        )}
      >
        {rule.effect === 'permit' ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <X className="size-3" aria-hidden="true" />
        )}
        {e.label}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="truncate text-label">{rule.name}</div>
        <Row label="WHO" chips={whoChips(rule.who, lookups)} tone="info" />
        <Row label="WHAT" chips={whatChips(rule.what, lookups)} mono />
        <Row label="WHEN" chips={whenChips(rule.when)} tone="berry" />
      </div>
      <div className="flex flex-col items-end gap-1.5 max-md:items-start">
        <span className="text-caption text-muted">
          {ruleScopeLabel(rule, lookups.teams)}
          {rule.enabled ? '' : ' · off'}
        </span>
        {canEdit ? (
          <span className="flex gap-1">
            <Button variant="outline" size="xs" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete rule" onClick={onDelete}>
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted">
            <Lock className="size-3" aria-hidden="true" />
            {rule.ownerTeamId ? 'Team rule' : 'Org rule'} · Admins edit
          </span>
        )}
      </div>
    </li>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function ChipList<T extends ChipData>({
  chips,
  tone,
  mono,
  onRemove,
}: {
  chips: T[];
  tone?: 'info' | 'berry';
  mono?: boolean;
  onRemove: (c: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <Chip
          key={c.key}
          {...(tone ? { tone } : {})}
          onRemove={() => onRemove(c)}
          removeLabel={`Remove ${c.label}`}
        >
          {mono ? <span className="font-mono">{c.label}</span> : c.label}
        </Chip>
      ))}
    </div>
  );
}

function RuleDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: PolicyRule | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const lookups = useRuleLookups();
  const save = useSavePolicyRule();
  const [name, setName] = React.useState('');
  const [priority, setPriority] = React.useState('100');
  const [ownerTeamId, setOwnerTeamId] = React.useState('');
  const [effect, setEffect] = React.useState<PolicyEffect>('forbid');
  const [who, setWho] = React.useState<RuleWho>({});
  const [what, setWhat] = React.useState<RuleWhat>({});
  const [when, setWhen] = React.useState<RuleWhen>({});
  const [pattern, setPattern] = React.useState('');
  const [client, setClient] = React.useState('');
  const [cidr, setCidr] = React.useState('');
  const [hoursFrom, setHoursFrom] = React.useState('8');
  const [hoursTo, setHoursTo] = React.useState('19');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setName(rule?.name ?? '');
      setPriority(String(rule?.priority ?? 100));
      setOwnerTeamId(rule?.ownerTeamId ?? '');
      setEffect(rule?.effect ?? 'forbid');
      setWho(rule?.who ?? {});
      setWhat(rule?.what ?? {});
      setWhen(rule?.when ?? {});
      setErrors({});
    }
  }, [open, rule]);
  const whoList = whoChips(who, lookups).filter((c) => c.key !== 'everyone');
  const whatList = whatChips(what, lookups).filter((c) => c.key !== 'any');
  const whenList = whenChips(when);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={rule ? 'Edit tool rule' : 'New tool rule'}
        description="Forbid always wins over permit. Without a person or a tool, a rule covers everyone and every tool."
        className="sm:max-w-xl"
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = ruleFormSchema.safeParse({ name, priority, ownerTeamId });
            if (!parsed.success) return setErrors(fieldErrors(parsed.error));
            setErrors({});
            const body: Body<'post', '/policy-rules'> = {
              name: parsed.data.name,
              ownerTeamId: parsed.data.ownerTeamId || null,
              effect,
              who,
              what,
              when,
              enabled: rule?.enabled ?? true,
              priority: parsed.data.priority,
            };
            save.mutate(
              { ...(rule ? { id: rule.id } : {}), rule: body },
              {
                onSuccess: () => {
                  toast.success('Rule saved');
                  onOpenChange(false);
                },
                onError: (err) =>
                  setErrors(
                    err instanceof ApiError && err.errors.length > 0
                      ? serverFieldErrors(err.errors)
                      : { form: err.message },
                  ),
              },
            );
          }}
        >
          <Field label="Name" required error={errors.name}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <div role="group" aria-label="Effect" className="flex gap-1 rounded-md bg-sunken p-1">
            {(['permit', 'forbid'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={effect === f}
                onClick={() => setEffect(f)}
                className={cn(
                  'h-9 flex-1 rounded-sm text-[13px] font-medium',
                  effect === f
                    ? f === 'permit'
                      ? 'bg-mint-soft text-mint-ink'
                      : 'bg-coral-soft text-coral-ink'
                    : 'text-muted',
                )}
              >
                {EFFECT[f].label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Who</span>
            <ChipList chips={whoList} tone="info" onRemove={(c) => setWho(removeWho(who, c.key))} />
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label="Add a team"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) =>
                  e.target.value && setWho({ ...who, teams: addTo(who.teams, e.target.value) })
                }
              >
                <option value="">+ Team</option>
                {lookups.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Add a role"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) =>
                  e.target.value && setWho({ ...who, role: e.target.value as RuleWho['role'] })
                }
              >
                <option value="">+ Role</option>
                <option value="member">Member</option>
                <option value="manager">Manager</option>
                <option value="auditor">Auditor</option>
                <option value="admin">Admin</option>
              </Select>
              <Select
                aria-label="Add a person"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) =>
                  e.target.value && setWho({ ...who, users: addTo(who.users, e.target.value) })
                }
              >
                <option value="">+ Person</option>
                {lookups.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Add a service account"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) =>
                  e.target.value &&
                  setWho({ ...who, serviceAccounts: addTo(who.serviceAccounts, e.target.value) })
                }
              >
                <option value="">+ Service account</option>
                {lookups.serviceAccounts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            {whoList.length === 0 ? (
              <span className="text-caption text-muted">Everyone</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">What</span>
            <ChipList chips={whatList} mono onRemove={(c) => setWhat(removeWhat(what, c.key))} />
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label="Add a server"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) =>
                  e.target.value && setWhat({ ...what, installationId: e.target.value })
                }
              >
                <option value="">+ Server</option>
                {lookups.installations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayName}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Add a tool pattern"
                placeholder="+ tool pattern, e.g. delete_*"
                value={pattern}
                className="h-9 w-56 text-[13px]"
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pattern.trim()) {
                    e.preventDefault();
                    setWhat({ ...what, toolName: pattern.trim() });
                    setPattern('');
                  }
                }}
              />
              <Select
                aria-label="Add a tool kind"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) => {
                  const key = e.target.value as 'destructive' | 'readOnly' | 'openWorld' | '';
                  if (key) setWhat({ ...what, annotations: { ...what.annotations, [key]: true } });
                }}
              >
                <option value="">+ Tool kind</option>
                <option value="destructive">Destructive tools</option>
                <option value="readOnly">Read-only tools</option>
                <option value="openWorld">Open-world tools</option>
              </Select>
            </div>
            {whatList.length === 0 ? (
              <span className="text-caption text-muted">Any tool</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">When</span>
            <ChipList
              chips={whenList}
              tone="berry"
              onRemove={(c) => setWhen(removeWhen(when, c.key))}
            />
            <div role="group" aria-label="Days of the week" className="flex flex-wrap gap-1">
              {WEEKDAYS.map((d, i) => {
                const on = when.weekdays?.includes(i) ?? false;
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const next = on
                        ? (when.weekdays ?? []).filter((x) => x !== i)
                        : [...(when.weekdays ?? []), i];
                      const { weekdays: _drop, ...rest } = when;
                      setWhen(next.length > 0 ? { ...rest, weekdays: next } : rest);
                    }}
                    className={cn(
                      'h-8 rounded-sm px-2.5 text-caption font-medium',
                      on ? 'bg-berry-soft text-berry-ink' : 'bg-sunken text-muted',
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Hours from"
                value={hoursFrom}
                className="h-9 w-auto text-[13px]"
                onChange={(e) => setHoursFrom(e.target.value)}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
              <span aria-hidden="true">to</span>
              <Select
                aria-label="Hours to"
                value={hoursTo}
                className="h-9 w-auto text-[13px]"
                onChange={(e) => setHoursTo(e.target.value)}
              >
                {Array.from({ length: 25 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  setWhen({ ...when, hours: { from: Number(hoursFrom), to: Number(hoursTo) } })
                }
              >
                Set hours
              </Button>
            </div>
            <Input
              aria-label="Add a client"
              placeholder="+ client id, e.g. claude-code"
              value={client}
              className="h-9 text-[13px]"
              onChange={(e) => setClient(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && client.trim()) {
                  e.preventDefault();
                  setWhen({ ...when, clientIds: addTo(when.clientIds, client.trim()) });
                  setClient('');
                }
              }}
            />
            <Input
              aria-label="Add an IP range"
              aria-invalid={Boolean(errors.cidr)}
              placeholder="+ IP range, e.g. 10.0.0.0/8"
              value={cidr}
              className="h-9 text-[13px]"
              onChange={(e) => setCidr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !cidr.trim()) return;
                e.preventDefault();
                if (!CIDR.test(cidr.trim())) {
                  setErrors({ ...errors, cidr: 'Enter an IP address or a CIDR range' });
                  return;
                }
                const { cidr: _drop, ...rest } = errors;
                setErrors(rest);
                setWhen({ ...when, ipCidrs: addTo(when.ipCidrs, cidr.trim()) });
                setCidr('');
              }}
            />
            {errors.cidr ? (
              <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                {errors.cidr}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Applies to"
              help="Org rules are edited by admins; a team rule names its owner."
            >
              {({ id }) => (
                <Select
                  id={id}
                  value={ownerTeamId}
                  onChange={(e) => setOwnerTeamId(e.target.value)}
                >
                  <option value="">The whole org</option>
                  {lookups.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      Team · {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Priority" error={errors.priority}>
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={100000}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="m-0 rounded-md bg-sunken p-3.5 text-[14px] text-muted">
            Forbid wins over permit. Use the policy simulator on this page to see how the rules
            decide for a given person and tool before you rely on them.
          </p>
          {errors.form ? (
            <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
              {errors.form}
            </p>
          ) : null}
          <Button type="submit" disabled={save.isPending}>
            Save rule
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SimBody = Body<'post', '/policies/simulate'>;
type SimResult = Res<'post', '/policies/simulate'>;

/** The simulator's answer: which policies decided, and whether the call is allowed. */
function SimulationResult({ result }: { result: SimResult }) {
  const denied = result.decision === 'deny';
  const deciding = result.determiningPolicies;
  return (
    <div aria-live="polite" className="flex flex-col gap-3">
      <div
        className={cn(
          'flex items-center gap-3.5 rounded-lg p-4',
          denied ? 'bg-coral-soft' : 'bg-mint-soft',
        )}
      >
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full text-on-bright',
            denied ? 'bg-coral' : 'bg-mint',
          )}
        >
          {denied ? (
            <X className="size-5" strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Check className="size-5" strokeWidth={2.25} aria-hidden="true" />
          )}
        </span>
        <div>
          <div className={cn('text-card-title', denied ? 'text-coral-ink' : 'text-mint-ink')}>
            {denied ? 'Denied' : 'Allowed'}
          </div>
          <div className="text-caption">
            {result.errors.length > 0
              ? result.errors.join(' ')
              : `Decided by ${result.reasons.join(', ') || 'the defaults'}`}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-overline">Policies that decided</span>
        {deciding.map((p) => {
          const forbid = /^\s*forbid\b/m.test(p.text);
          return (
            <div
              key={p.id}
              data-deciding
              className={cn(
                'flex items-center gap-2 rounded-md border-[1.5px] px-2.5 py-2',
                forbid ? 'border-coral-ink' : 'border-mint-ink',
              )}
            >
              <Tag tone={forbid ? 'bad' : 'ok'}>{forbid ? 'forbid' : 'permit'}</Tag>
              <span className="font-mono text-[12px]">{p.id}</span>
              <span className="ml-auto text-[11px] font-semibold">Decided</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Simulator() {
  const users = useUsers({});
  const installs = useInstallations();
  const sim = useSimulate();
  const [userId, setUserId] = React.useState('');
  const [installationId, setInstallationId] = React.useState('');
  const [action, setAction] = React.useState<'callTool' | 'getPrompt' | 'readResource'>('callTool');
  const [tool, setTool] = React.useState('slack_post_message');
  const person = users.data?.find((u) => u.id === userId);
  const installation = installs.data?.find((i) => i.id === installationId);
  React.useEffect(() => {
    if (!userId && users.data?.[3]) setUserId(users.data[3].id);
  }, [users.data, userId]);
  React.useEffect(() => {
    if (!installationId && installs.data?.length) {
      setInstallationId(
        (installs.data.find((i) => i.slug === 'slack') ?? installs.data[0])?.id ?? '',
      );
    }
  }, [installs.data, installationId]);
  const run = () => {
    if (!person || !installation) return;
    const target = {
      installation: {
        id: installation.id,
        catalogEntryId: installation.catalogEntryId ?? installation.id,
      },
    };
    const body: SimBody = {
      principal: {
        kind: 'user',
        id: person.id,
        role: person.orgRole,
        teams: person.teams.map((t) => ({ id: t.id, role: t.role })),
      },
      action,
      resource:
        action === 'getPrompt'
          ? { type: 'Prompt', ...target, name: tool }
          : action === 'readResource'
            ? { type: 'Resource', ...target, uri: tool }
            : { type: 'Tool', ...target, name: tool },
    };
    sim.mutate(body);
  };
  return (
    <Card aria-label="Policy simulator" className="gap-3.5">
      <CardHeader title="Try a decision" />
      <Field label="Person">
        {({ id }) => (
          <div className="flex items-center gap-2">
            {person ? <Avatar name={person.name} size={24} /> : null}
            <Select id={id} value={userId} onChange={(e) => setUserId(e.target.value)}>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.teams[0] ? ` · ${u.teams[0].name}` : ''}
                </option>
              ))}
            </Select>
          </div>
        )}
      </Field>
      <Field label="Server">
        {({ id }) => (
          <Select
            id={id}
            value={installationId}
            onChange={(e) => setInstallationId(e.target.value)}
          >
            {(installs.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Action">
        {({ id }) => (
          <Select
            id={id}
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
          >
            <option value="callTool">Call a tool</option>
            <option value="getPrompt">Get a prompt</option>
            <option value="readResource">Read a resource</option>
          </Select>
        )}
      </Field>
      <Field
        label={action === 'callTool' ? 'Tool' : action === 'getPrompt' ? 'Prompt' : 'Resource URI'}
      >
        {({ id }) => (
          <Input
            id={id}
            className="font-mono"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          />
        )}
      </Field>
      <Button
        size="sm"
        className="self-start"
        disabled={!person || !installation || !tool.trim() || sim.isPending}
        onClick={run}
      >
        <Play className="size-4" aria-hidden="true" />
        Simulate
      </Button>
      {sim.data ? <SimulationResult result={sim.data} /> : null}
    </Card>
  );
}

export function RulesTab() {
  const { role } = useAuth();
  const rules = usePolicyRules();
  const del = useDeletePolicyRule();
  const lookups = useRuleLookups();
  const [editing, setEditing] = React.useState<PolicyRule | 'new' | null>(null);
  // Writing rules needs `policies.write` on the org: admins only (10.1).
  const canEdit = role === 'admin';
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <Card aria-label="Tool rules" className="gap-3">
        <CardHeader
          title="Tool rules"
          subtitle="Forbid always wins"
          actions={
            canEdit ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                Add rule
              </Button>
            ) : null
          }
        />
        <QueryBoundary
          query={rules}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              title="No tool rules"
              description="By default every installed tool is allowed. Add a rule to change that."
              action={canEdit ? { label: 'Add rule', onClick: () => setEditing('new') } : undefined}
            />
          }
        >
          {(items) => (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {[...items]
                .sort((a, b) => a.priority - b.priority)
                .map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    lookups={lookups}
                    canEdit={canEdit}
                    onEdit={() => setEditing(r)}
                    onDelete={() =>
                      del.mutate(r.id, { onSuccess: () => toast.success('Rule removed') })
                    }
                  />
                ))}
            </ul>
          )}
        </QueryBoundary>
      </Card>
      {canEdit ? <Simulator /> : null}
      <RuleDialog
        rule={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  );
}

/** Adds a test case to a custom policy: who does what, and whether the answer is allow or deny. */
function TestBuilder({ onAdd }: { onAdd: (t: PolicyTest) => void }) {
  const teams = useTeams();
  const installs = useInstallations();
  const [name, setName] = React.useState('');
  const [expectation, setExpectation] = React.useState<'allow' | 'deny'>('deny');
  const [action, setAction] = React.useState<(typeof TEST_ACTIONS)[number]>('callTool');
  const [role, setRole] = React.useState<'admin' | 'auditor' | 'member'>('member');
  const [teamId, setTeamId] = React.useState('');
  const [installationId, setInstallationId] = React.useState('');
  const [toolName, setToolName] = React.useState('');
  const first = installs.data?.[0];
  const installation = installs.data?.find((i) => i.id === installationId) ?? first;
  return (
    <fieldset className="m-0 flex flex-col gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-overline">Add a test</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Test name"
          placeholder="Name, e.g. Support cannot post"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          aria-label="Expected answer"
          value={expectation}
          onChange={(e) => setExpectation(e.target.value as typeof expectation)}
        >
          <option value="allow">Expect allow</option>
          <option value="deny">Expect deny</option>
        </Select>
        <Select
          aria-label="Test role"
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
        >
          <option value="member">A member</option>
          <option value="auditor">An auditor</option>
          <option value="admin">An admin</option>
        </Select>
        <Select aria-label="Test team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">On no team</option>
          {(teams.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              On {t.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Test action"
          value={action}
          onChange={(e) => setAction(e.target.value as typeof action)}
        >
          {TEST_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Test server"
          value={installation?.id ?? ''}
          onChange={(e) => setInstallationId(e.target.value)}
        >
          {(installs.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.displayName}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Test tool"
          className="font-mono sm:col-span-2"
          placeholder="Tool name, prompt name or resource URI"
          value={toolName}
          onChange={(e) => setToolName(e.target.value)}
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={!name.trim() || !toolName.trim() || !installation}
        onClick={() => {
          if (!installation) return;
          onAdd(
            buildPolicyTest({
              name: name.trim(),
              expect: expectation,
              action,
              role,
              teamId,
              teamRole: 'member',
              installationId: installation.id,
              catalogEntryId: installation.catalogEntryId ?? installation.id,
              toolName: toolName.trim(),
            }),
          );
          setName('');
          setToolName('');
        }}
      >
        Add test
      </Button>
    </fieldset>
  );
}

export function CedarDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const policies = useCustomPolicies();
  const save = useSaveCustomPolicy();
  const del = useDeleteCustomPolicy();
  const validate = useValidatePolicy();
  const [selected, setSelected] = React.useState<CustomPolicy | 'new' | null>(null);
  const [name, setName] = React.useState('');
  const [cedar, setCedar] = React.useState('');
  const [tests, setTests] = React.useState<PolicyTest[]>([]);
  const [error, setError] = React.useState<string | undefined>();
  const current = selected && selected !== 'new' ? selected : null;
  React.useEffect(() => {
    if (open && !selected && policies.data?.[0]) setSelected(policies.data[0]);
  }, [open, selected, policies.data]);
  React.useEffect(() => {
    if (selected === 'new') {
      setName('');
      setCedar(CEDAR_SAMPLE_NEW);
      setTests([]);
    } else if (selected) {
      setName(selected.name);
      setCedar(selected.cedar);
      setTests(selected.tests as PolicyTest[]);
    }
    setError(undefined);
  }, [selected]);
  const { mutate: runValidate } = validate;
  React.useEffect(() => {
    if (!open || !cedar) return;
    const t = setTimeout(() => runValidate({ cedar, tests }), 350);
    return () => clearTimeout(t);
  }, [open, cedar, tests, runValidate]);
  const report = validate.data;
  const errors = report?.errors ?? [];
  const failing = (report?.tests ?? []).filter((t) => !t.passed);
  const problems = [
    ...errors,
    ...failing.map((t) => `Test "${t.name}" expected ${t.expected} but got ${t.actual}`),
  ];
  const valid = report?.ok === true;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Custom Cedar policies"
        description="Hand-written policies are evaluated together with the generated ones. Every policy needs at least one passing test."
        className="sm:max-w-3xl"
      >
        <div className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
          <ul aria-label="Policies" className="m-0 flex list-none flex-col gap-1 p-0">
            {(policies.data ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={current?.id === p.id}
                  onClick={() => setSelected(p)}
                  className={cn(
                    'h-10 w-full rounded-md px-3 text-left text-label',
                    current?.id === p.id
                      ? 'bg-tangerine-soft text-tangerine-ink'
                      : 'hover:bg-sunken',
                  )}
                >
                  {p.name}
                </button>
              </li>
            ))}
            <li>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setSelected('new')}
              >
                New policy
              </Button>
            </li>
          </ul>
          <div className="flex min-w-0 flex-col gap-3">
            <Field label="Name">
              {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <CodeEditor
              language="cedar"
              ariaLabel="Cedar policy"
              value={cedar}
              onChange={setCedar}
              height={260}
              markers={toMarkers(errors)}
            />
            {valid ? (
              <p className="m-0 text-caption font-medium text-mint-ink">The policy is valid.</p>
            ) : problems.length > 0 ? (
              <ul
                role="alert"
                aria-label="Policy errors"
                className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
              >
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <span className="text-overline">Tests ({tests.length})</span>
              <ul aria-label="Policy tests" className="m-0 flex list-none flex-col gap-1 p-0">
                {tests.map((t, i) => (
                  <li key={`${t.name}-${i}`}>
                    <Chip
                      onRemove={() => setTests(tests.filter((_, j) => j !== i))}
                      removeLabel={`Remove test ${t.name}`}
                    >
                      {t.name} · expect {t.expect}
                    </Chip>
                  </li>
                ))}
              </ul>
              <TestBuilder onAdd={(t) => setTests([...tests, t])} />
            </div>
            {error ? (
              <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                disabled={!name.trim() || !valid || save.isPending}
                onClick={() => {
                  const parsed = policyFormSchema.safeParse({ name });
                  if (!parsed.success) return setError(fieldErrors(parsed.error).name);
                  setError(undefined);
                  save.mutate(
                    {
                      ...(current ? { id: current.id } : {}),
                      policy: {
                        name: parsed.data.name,
                        cedar,
                        tests,
                        enabled: current?.enabled ?? true,
                      },
                    },
                    {
                      onSuccess: () => toast.success('Policy saved'),
                      onError: (e) => setError(e.message),
                    },
                  );
                }}
              >
                Save policy
              </Button>
              {current ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    del.mutate(current.id, {
                      onSuccess: () => {
                        setSelected(null);
                        toast.success('Policy removed');
                      },
                    })
                  }
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
