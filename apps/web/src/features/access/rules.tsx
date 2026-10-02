import { Check, Lock, Play, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useCustomPolicies,
  useDeleteCustomPolicy,
  useDeletePolicyRule,
  useInstallations,
  usePolicyRules,
  usePreviewPolicyRule,
  useSaveCustomPolicy,
  useSavePolicyRule,
  useSimulate,
  useTeams,
  useUsers,
  useValidatePolicy,
} from '@/api/hooks';
import type {
  CustomPolicy,
  PolicyEffect,
  PolicyRule,
  PolicyRuleInput,
  RuleChip,
} from '@/api/types';
import { CodeEditor } from '@/components/code-editor';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Avatar, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { CEDAR_SAMPLE_NEW } from './cedar-sample';

const EFFECT = {
  permit: { label: 'Permit', cls: 'bg-mint-soft text-mint-ink' },
  forbid: { label: 'Forbid', cls: 'bg-coral-soft text-coral-ink' },
} as const;

function Row({
  label,
  chips,
  mono,
  tone,
}: {
  label: string;
  chips: string[];
  mono?: boolean;
  tone?: 'info' | 'berry';
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[42px] text-[11px] font-semibold text-muted">{label}</span>
      {chips.map((c) => (
        <span
          key={c}
          className={cn(
            'inline-flex h-6 items-center rounded-sm px-2 text-caption font-medium',
            tone === 'info' && 'bg-sky-soft text-sky-ink',
            tone === 'berry' && 'bg-berry-soft text-berry-ink',
            !tone && 'bg-sunken',
            mono && 'font-mono',
          )}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function RuleRow({
  rule,
  onEdit,
  onDelete,
}: {
  rule: PolicyRule;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const e = EFFECT[rule.effect];
  return (
    <li
      className={cn(
        'grid grid-cols-[76px_minmax(0,1fr)_150px] items-center gap-3.5 rounded-md border border-line p-3.5 max-md:grid-cols-1',
        !rule.canEdit && 'bg-sunken',
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
        <Row label="WHO" chips={rule.who.map((c) => c.label)} tone="info" />
        <Row label="WHAT" chips={rule.what.map((c) => c.label)} mono />
        <Row label="WHEN" chips={rule.when} tone="berry" />
      </div>
      <div className="flex flex-col items-end gap-1.5 max-md:items-start">
        <span className="text-caption text-muted">
          {formatNumber(rule.affected.people)} {rule.affected.people === 1 ? 'person' : 'people'} ·{' '}
          {formatNumber(rule.affected.tools)} {rule.affected.tools === 1 ? 'tool' : 'tools'}
        </span>
        {rule.canEdit ? (
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
            Org rule · Admins edit
          </span>
        )}
      </div>
    </li>
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
  const teams = useTeams();
  const installs = useInstallations();
  const save = useSavePolicyRule();
  const preview = usePreviewPolicyRule();
  const [effect, setEffect] = React.useState<PolicyEffect>(rule?.effect ?? 'forbid');
  const [who, setWho] = React.useState<RuleChip[]>(rule?.who ?? []);
  const [what, setWhat] = React.useState<RuleChip[]>(rule?.what ?? []);
  const [when, setWhen] = React.useState<string[]>(rule?.when ?? []);
  const [pattern, setPattern] = React.useState('');
  const [hours, setHours] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  React.useEffect(() => {
    if (open) {
      setEffect(rule?.effect ?? 'forbid');
      setWho(rule?.who ?? []);
      setWhat(rule?.what ?? []);
      setWhen(rule?.when ?? []);
      setError(undefined);
    }
  }, [open, rule]);
  const { mutate } = preview;
  React.useEffect(() => {
    if (open && who.length && what.length) {
      const t = setTimeout(() => mutate({ effect, who, what, when }), 200);
      return () => clearTimeout(t);
    }
  }, [open, effect, who, what, when, mutate]);
  const input: PolicyRuleInput = { effect, who, what, when };
  const addUnique = (list: RuleChip[], c: RuleChip) =>
    list.some((x) => x.label === c.label) ? list : [...list, c];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={rule ? 'Edit tool rule' : 'New tool rule'}
        description="Forbid always wins over permit."
        className="sm:max-w-xl"
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!who.length || !what.length)
              return setError('Pick who it applies to and what it covers');
            save.mutate(
              { ...(rule ? { id: rule.id } : {}), rule: input },
              {
                onSuccess: () => {
                  toast.success('Rule saved');
                  onOpenChange(false);
                },
              },
            );
          }}
        >
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
            <div className="flex flex-wrap gap-1.5">
              {who.map((c) => (
                <Chip
                  key={c.label}
                  tone="info"
                  onRemove={() => setWho(who.filter((x) => x !== c))}
                  removeLabel={`Remove ${c.label}`}
                >
                  {c.label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setWho(addUnique(who, { type: 'everyone', label: 'Everyone' }))}
              >
                Everyone
              </Button>
              <Select
                aria-label="Add a team"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) => {
                  const t = teams.data?.find((x) => x.id === e.target.value);
                  if (t) setWho(addUnique(who, { type: 'team', label: `Team · ${t.name}` }));
                }}
              >
                <option value="">+ Team</option>
                {(teams.data ?? []).map((t) => (
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
                  e.target.value &&
                  setWho(addUnique(who, { type: 'role', label: `Role · ${e.target.value}` }))
                }
              >
                <option value="">+ Role</option>
                <option value="Member">Member</option>
                <option value="Auditor">Auditor</option>
                <option value="Admin">Admin</option>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">What</span>
            <div className="flex flex-wrap gap-1.5">
              {what.map((c) => (
                <Chip
                  key={c.label}
                  onRemove={() => setWhat(what.filter((x) => x !== c))}
                  removeLabel={`Remove ${c.label}`}
                >
                  <span className="font-mono">{c.label}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label="Add a server"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) => {
                  const i = installs.data?.find((x) => x.id === e.target.value);
                  if (i) setWhat(addUnique(what, { type: 'server', label: i.displayName }));
                }}
              >
                <option value="">+ Server</option>
                {(installs.data ?? []).map((i) => (
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
                    setWhat(addUnique(what, { type: 'tools', label: pattern.trim() }));
                    setPattern('');
                  }
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">When</span>
            <div className="flex flex-wrap gap-1.5">
              {when.map((w) => (
                <Chip
                  key={w}
                  tone="berry"
                  onRemove={() => setWhen(when.filter((x) => x !== w))}
                  removeLabel={`Remove ${w}`}
                >
                  {w}
                </Chip>
              ))}
            </div>
            <Input
              aria-label="Add a condition"
              placeholder="+ condition, e.g. Weekdays 08:00–19:00"
              value={hours}
              className="h-9 text-[13px]"
              onChange={(e) => setHours(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hours.trim()) {
                  e.preventDefault();
                  setWhen([...when, hours.trim()]);
                  setHours('');
                }
              }}
            />
          </div>
          <div aria-live="polite" className="rounded-md bg-sunken p-3.5 text-[14px]">
            {preview.data && who.length && what.length ? (
              <>
                <strong className="font-semibold">
                  {formatNumber(preview.data.people)} people
                </strong>{' '}
                and{' '}
                <strong className="font-semibold">{formatNumber(preview.data.tools)} tools</strong>{' '}
                are affected.
              </>
            ) : (
              'Add who and what to see how many people and tools this affects.'
            )}
          </div>
          {error ? (
            <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
              {error}
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

function Simulator() {
  const users = useUsers({});
  const installs = useInstallations();
  const sim = useSimulate();
  const [userId, setUserId] = React.useState('');
  const [action, setAction] = React.useState('callTool');
  const [tool, setTool] = React.useState('slack_post_message');
  const r = sim.data;
  const person = users.data?.find((u) => u.id === userId);
  React.useEffect(() => {
    if (!userId && users.data?.[3]) setUserId(users.data[3].id);
  }, [users.data, userId]);
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
      <Field label="Action">
        {({ id }) => (
          <Select id={id} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="callTool">Call a tool</option>
            <option value="getPrompt">Get a prompt</option>
            <option value="readResource">Read a resource</option>
          </Select>
        )}
      </Field>
      <Field label="Tool">
        {({ id }) => (
          <Input
            id={id}
            className="font-mono"
            list="sim-tools"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          />
        )}
      </Field>
      <datalist id="sim-tools">
        {(installs.data ?? []).map((i) => (
          <option key={i.id} value={`${i.slug}_search`} />
        ))}
      </datalist>
      <Button
        size="sm"
        className="self-start"
        disabled={!userId || sim.isPending}
        onClick={() => sim.mutate({ userId, action, tool })}
      >
        <Play className="size-4" aria-hidden="true" />
        Simulate
      </Button>
      {r ? (
        <div aria-live="polite" className="flex flex-col gap-3">
          <div
            className={cn(
              'flex items-center gap-3.5 rounded-lg p-4',
              r.decision === 'deny' ? 'bg-coral-soft' : 'bg-mint-soft',
            )}
          >
            <span
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-full text-on-bright',
                r.decision === 'deny' ? 'bg-coral' : 'bg-mint',
              )}
            >
              {r.decision === 'deny' ? (
                <X className="size-5" strokeWidth={2.25} aria-hidden="true" />
              ) : (
                <Check className="size-5" strokeWidth={2.25} aria-hidden="true" />
              )}
            </span>
            <div>
              <div
                className={cn(
                  'text-card-title',
                  r.decision === 'deny' ? 'text-coral-ink' : 'text-mint-ink',
                )}
              >
                {r.decision === 'deny' ? 'Denied' : 'Allowed'}
              </div>
              <div className="text-caption">{r.summary}</div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-overline">Rules that matched</span>
            {r.matches.map((m) => (
              <div
                key={m.id}
                data-deciding={m.deciding || undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-2',
                  m.deciding
                    ? m.effect === 'forbid'
                      ? 'border-[1.5px] border-coral-ink'
                      : 'border-[1.5px] border-mint-ink'
                    : 'border-line opacity-70',
                )}
              >
                <Tag tone={m.effect === 'forbid' ? 'bad' : 'ok'}>{m.effect}</Tag>
                <span className="font-mono text-[12px]">{m.label}</span>
                {m.deciding ? (
                  <span className="ml-auto text-[11px] font-semibold">Decided</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function RulesTab() {
  const rules = usePolicyRules();
  const del = useDeletePolicyRule();
  const [editing, setEditing] = React.useState<PolicyRule | 'new' | null>(null);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <Card aria-label="Tool rules" className="gap-3">
        <CardHeader
          title="Tool rules"
          subtitle="Forbid always wins"
          actions={
            <Button size="sm" onClick={() => setEditing('new')}>
              Add rule
            </Button>
          }
        />
        <QueryBoundary
          query={rules}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              title="No tool rules"
              description="By default every installed tool is allowed. Add a rule to change that."
              action={{ label: 'Add rule', onClick: () => setEditing('new') }}
            />
          }
        >
          {(items) => (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {items.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
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
      <Simulator />
      <RuleDialog
        rule={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
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
  const current = selected && selected !== 'new' ? selected : null;
  React.useEffect(() => {
    if (open && !selected && policies.data?.[0]) setSelected(policies.data[0]);
  }, [open, selected, policies.data]);
  React.useEffect(() => {
    if (selected === 'new') {
      setName('');
      setCedar(CEDAR_SAMPLE_NEW);
    } else if (selected) {
      setName(selected.name);
      setCedar(selected.cedar);
    }
  }, [selected]);
  const { mutate: runValidate } = validate;
  React.useEffect(() => {
    if (!open || !cedar) return;
    const t = setTimeout(() => runValidate(cedar), 350);
    return () => clearTimeout(t);
  }, [open, cedar, runValidate]);
  const errors = validate.data?.errors ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Custom Cedar policies"
        description="Hand-written policies are evaluated together with the generated ones."
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
              height={300}
              markers={errors}
            />
            {errors.length === 0 && cedar ? (
              <p className="m-0 text-caption font-medium text-mint-ink">The policy is valid.</p>
            ) : (
              <ul
                role="alert"
                aria-label="Policy errors"
                className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
              >
                {errors.map((e) => (
                  <li key={`${e.line}${e.message}`}>
                    Line {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Button
                disabled={!name.trim() || errors.length > 0 || save.isPending}
                onClick={() =>
                  save.mutate(
                    {
                      ...(current ? { id: current.id } : {}),
                      policy: { name: name.trim(), cedar, enabled: current?.enabled ?? true },
                    },
                    { onSuccess: () => toast.success('Policy saved') },
                  )
                }
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
