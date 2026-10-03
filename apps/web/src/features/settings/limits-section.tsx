import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  useCreateLimitRule,
  useDeleteLimitRule,
  useLimitRules,
  usePatchLimitRule,
  useTeamOptions,
} from '@/api/hooks';
import {
  describeLimit,
  describeScope,
  emptyLimitForm,
  LIMIT_ACTIONS,
  LIMIT_METRICS,
  LIMIT_PERIODS,
  LIMIT_SUBJECTS,
  type LimitFormValues,
  type LimitRule,
  limitCreateBody,
  limitPatchBody,
  limitToForm,
  SUBJECT_LABEL,
} from '@/api/views/settings';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { applyServerErrors } from './form-errors';

const positive = (what: string) =>
  z
    .number({ message: `${what} must be a number` })
    .int('Whole numbers only')
    .positive('Must be above zero');

/**
 * Mirrors the rule model of `@bastion-mcp/limits` (`RateRuleSchema`, `QuotaRuleSchema`,
 * `ConcurrencyRuleSchema`): the parameters that apply depend on the kind.
 */
const limitSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the rule'),
    kind: z.enum(['rate', 'quota', 'concurrency']),
    subject: z.enum(LIMIT_SUBJECTS),
    subjectIds: z.string(),
    metric: z.enum(LIMIT_METRICS),
    action: z.enum(LIMIT_ACTIONS),
    enabled: z.boolean(),
    ownerTeamId: z.string(),
    tool: z.string(),
    method: z.string(),
    installationId: z.string(),
    catalogEntryId: z.string(),
    points: z.number(),
    perSeconds: z.number(),
    burst: z.number(),
    period: z.enum(LIMIT_PERIODS),
    max: z.number(),
    leaseSeconds: z.number(),
  })
  .superRefine((v, ctx) => {
    const check = (name: keyof LimitFormValues, schema: z.ZodType) => {
      const r = schema.safeParse(v[name]);
      if (!r.success)
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: r.error.issues[0]?.message ?? 'Invalid',
        });
    };
    if (v.kind === 'rate') {
      check('points', positive('Points'));
      check('perSeconds', positive('Seconds'));
      check(
        'burst',
        z
          .number({ message: 'Burst must be a number' })
          .int('Whole numbers only')
          .min(0, 'Zero or more'),
      );
    } else if (v.kind === 'quota') check('points', positive('Points'));
    else {
      check('max', positive('Maximum'));
      check('leaseSeconds', positive('Lease'));
    }
  });

function LimitDialog({ editing, onClose }: { editing: LimitRule | 'new'; onClose: () => void }) {
  const creating = editing === 'new';
  const create = useCreateLimitRule();
  const patch = usePatchLimitRule();
  const teams = useTeamOptions();
  const [formError, setFormError] = React.useState<string | undefined>();
  const form = useForm<LimitFormValues>({
    resolver: zodResolver(limitSchema),
    defaultValues: creating ? emptyLimitForm() : limitToForm(editing),
  });
  const { errors } = form.formState;
  const kind = form.watch('kind');
  const num = { valueAsNumber: true } as const;
  const submit = form.handleSubmit((v) => {
    setFormError(undefined);
    const done = {
      onSuccess: () => {
        toast.success('Limit saved');
        onClose();
      },
      onError: (e: Error) => setFormError(applyServerErrors(form, e)),
    };
    if (editing === 'new') create.mutate(limitCreateBody(v), done);
    else patch.mutate({ id: editing.id, body: limitPatchBody(v) }, done);
  });
  const number = (
    name: 'points' | 'perSeconds' | 'burst' | 'max' | 'leaseSeconds',
    label: string,
    help?: string,
  ) => (
    <Field label={label} help={help} error={errors[name]?.message}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          type="number"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          {...form.register(name, num)}
        />
      )}
    </Field>
  );
  const text = (
    name: 'subjectIds' | 'tool' | 'method' | 'installationId' | 'catalogEntryId',
    label: string,
    help?: string,
    placeholder?: string,
  ) => (
    <Field label={label} help={help} error={errors[name]?.message}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          placeholder={placeholder}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          {...form.register(name)}
        />
      )}
    </Field>
  );
  return (
    <form noValidate className="flex flex-col gap-3.5" onSubmit={submit}>
      <Field label="Name" required error={errors.name?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...form.register('name')}
          />
        )}
      </Field>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Kind" help={creating ? undefined : 'The kind cannot change'}>
          {({ id }) => (
            <Select id={id} disabled={!creating} {...form.register('kind')}>
              <option value="rate">Rate</option>
              <option value="quota">Quota</option>
              <option value="concurrency">Concurrency</option>
            </Select>
          )}
        </Field>
        <Field label="Applies to" error={errors.subject?.message}>
          {({ id }) => (
            <Select id={id} {...form.register('subject')}>
              {LIMIT_SUBJECTS.map((s) => (
                <option key={s} value={s}>
                  {SUBJECT_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {kind === 'rate' ? (
          <>
            {number('points', 'Calls allowed')}
            {number('perSeconds', 'Per (seconds)')}
            {number('burst', 'Burst', 'Extra calls allowed at once')}
          </>
        ) : null}
        {kind === 'quota' ? (
          <>
            {number('points', 'Allowance')}
            <Field label="Period">
              {({ id }) => (
                <Select id={id} {...form.register('period')}>
                  {LIMIT_PERIODS.map((p) => (
                    <option key={p} value={p}>
                      Per {p}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : null}
        {kind === 'concurrency' ? (
          <>
            {number('max', 'At once')}
            {number(
              'leaseSeconds',
              'Lease (seconds)',
              'A call that never ends frees its slot after this',
            )}
          </>
        ) : null}
        <Field label="Counts">
          {({ id }) => (
            <Select id={id} {...form.register('metric')}>
              <option value="calls">Calls</option>
              <option value="bytesOut">Bytes returned</option>
              <option value="samplingRequests">Sampling requests</option>
              <option value="modelGuardTokens">Model guard tokens</option>
            </Select>
          )}
        </Field>
        <Field label="When exceeded">
          {({ id }) => (
            <Select id={id} {...form.register('action')}>
              <option value="reject">Reject the call</option>
              <option value="warn">Warn only</option>
            </Select>
          )}
        </Field>
      </div>
      {text(
        'subjectIds',
        'Only these subjects (optional)',
        'Comma separated ids; empty counts each one separately',
      )}
      <fieldset className="m-0 grid gap-3.5 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-1.5 text-[13px] font-medium">Narrow it to (optional)</legend>
        {text('tool', 'Tool', undefined, 'github__*')}
        {text('method', 'Method', undefined, 'tools/call')}
        {text('installationId', 'Installation id')}
        {text('catalogEntryId', 'Catalog entry id')}
      </fieldset>
      <Field label="Owning team" help="Leave empty for an organization-wide rule">
        {({ id }) => (
          <Select id={id} {...form.register('ownerTeamId')}>
            <option value="">Organization</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-center gap-3">
        <Switch
          checked={form.watch('enabled')}
          onCheckedChange={(v) => form.setValue('enabled', v, { shouldDirty: true })}
          aria-label="Enabled"
        />
        <span className="text-label">Enabled</span>
      </label>
      {formError ? (
        <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={create.isPending || patch.isPending}>
        Save limit
      </Button>
    </form>
  );
}

export function LimitsSection() {
  const q = useLimitRules();
  const del = useDeleteLimitRule();
  const [editing, setEditing] = React.useState<LimitRule | 'new' | null>(null);
  return (
    <Card aria-label="Limits" className="gap-3">
      <CardHeader
        title="Limits"
        subtitle="Rate, quota and concurrency rules (14)"
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            Add rule
          </Button>
        }
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No limits"
            description="Defaults apply until you add a rule."
            action={{ label: 'Add rule', onClick: () => setEditing('new') }}
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <span className="min-w-0 flex-1 text-label">{r.name}</span>
                <Tag>{r.kind}</Tag>
                {r.enabled ? null : <Tag tone="neutral">Off</Tag>}
                <span className="text-caption text-muted">
                  {describeScope(r)} · {describeLimit(r)}
                </span>
                <Button variant="ghost" size="xs" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Delete ${r.name}`}
                  onClick={() => del.mutate(r.id)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'New limit' : 'Edit limit'}>
          {editing ? (
            <LimitDialog
              key={editing === 'new' ? 'new' : editing.id}
              editing={editing}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
