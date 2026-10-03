import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useSavePolicyRule } from '@/api/hooks';
import type { Body } from '@/api/schema';
import {
  addTo,
  type Chip as ChipData,
  type RuleWho,
  removeWhat,
  removeWhen,
  removeWho,
  whatChips,
  whenChips,
  whoChips,
} from '@/api/views/access';
import { Field } from '@/components/form';
import { Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { fieldErrors, serverFieldErrors } from '@/lib/form-errors';
import { pad2 } from '@/lib/format';
import { CIDR, ruleFormSchema } from '../forms';
import { useRuleLookups } from './lookups';
import {
  DEFAULT_HOURS_FROM,
  DEFAULT_HOURS_TO,
  type PolicyRule,
  type RuleDraft,
  ruleDraftOf,
} from './rule-draft';
import { EFFECT } from './rule-row';

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

/** The tool rule dialog. Its form exists only while the dialog is open, so it always starts from the rule given. */
export function RuleDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: PolicyRule | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={rule ? 'Edit tool rule' : 'New tool rule'}
        description="Forbid always wins over permit. Without a person or a tool, a rule covers everyone and every tool."
        className="sm:max-w-xl"
      >
        <RuleForm key={rule?.id ?? 'new'} rule={rule} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RuleForm({ rule, onDone }: { rule: PolicyRule | null; onDone: () => void }) {
  const lookups = useRuleLookups();
  const save = useSavePolicyRule();
  const [draft, setDraft] = React.useState<RuleDraft>(() => ruleDraftOf(rule));
  const patch = (next: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...next }));
  // What is being typed into the inputs that add a chip; it is not part of the rule until Enter or a button.
  const [pattern, setPattern] = React.useState('');
  const [client, setClient] = React.useState('');
  const [cidr, setCidr] = React.useState('');
  const [hoursFrom, setHoursFrom] = React.useState(String(DEFAULT_HOURS_FROM));
  const [hoursTo, setHoursTo] = React.useState(String(DEFAULT_HOURS_TO));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const { name, priority, ownerTeamId, effect, who, what, when } = draft;
  const whoList = whoChips(who, lookups).filter((c) => c.key !== 'everyone');
  const whatList = whatChips(what, lookups).filter((c) => c.key !== 'any');
  const whenList = whenChips(when);
  const setWho = (next: typeof who) => patch({ who: next });
  const setWhat = (next: typeof what) => patch({ what: next });
  const setWhen = (next: typeof when) => patch({ when: next });
  return (
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
              onDone();
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
            onChange={(e) => patch({ name: e.target.value })}
          />
        )}
      </Field>
      <div role="group" aria-label="Effect" className="flex gap-1 rounded-md bg-sunken p-1">
        {(['permit', 'forbid'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={effect === f}
            onClick={() => patch({ effect: f })}
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
        {whoList.length === 0 ? <span className="text-caption text-muted">Everyone</span> : null}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">What</span>
        <ChipList chips={whatList} mono onRemove={(c) => setWhat(removeWhat(what, c.key))} />
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Add a server"
            value=""
            className="h-9 w-auto text-[13px]"
            onChange={(e) => e.target.value && setWhat({ ...what, installationId: e.target.value })}
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
        {whatList.length === 0 ? <span className="text-caption text-muted">Any tool</span> : null}
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
                {pad2(h)}:00
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
                {pad2(h)}:00
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
              onChange={(e) => patch({ ownerTeamId: e.target.value })}
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
              onChange={(e) => patch({ priority: e.target.value })}
            />
          )}
        </Field>
      </div>
      <p className="m-0 rounded-md bg-sunken p-3.5 text-[14px] text-muted">
        Forbid wins over permit. Use the policy simulator on this page to see how the rules decide
        for a given person and tool before you rely on them.
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
  );
}
