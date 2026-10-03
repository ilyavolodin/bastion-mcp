import * as React from 'react';
import { toast } from 'sonner';
import {
  useCustomPolicies,
  useDeleteCustomPolicy,
  useSaveCustomPolicy,
  useValidatePolicy,
} from '@/api/hooks';
import type { Schemas } from '@/api/schema';
import { CodeEditor } from '@/components/code-editor';
import { Field } from '@/components/form';
import { Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DEBOUNCE_VALIDATE_MS, useDebounced } from '@/hooks/use-debounced-value';
import { cn } from '@/lib/cn';
import { fieldErrors } from '@/lib/form-errors';
import { CEDAR_SAMPLE_NEW } from '../cedar-sample';
import { type PolicyTest, policyFormSchema, toMarkers } from '../forms';
import { TestBuilder } from './test-builder';

type CustomPolicy = Schemas['CustomPolicy'];

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
  const settledCedar = useDebounced(cedar, DEBOUNCE_VALIDATE_MS);
  const settledTests = useDebounced(tests, DEBOUNCE_VALIDATE_MS);
  React.useEffect(() => {
    if (!open || !cedar || settledCedar !== cedar || settledTests !== tests) return;
    runValidate({ cedar, tests });
  }, [open, cedar, tests, settledCedar, settledTests, runValidate]);
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
