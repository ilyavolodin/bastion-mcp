import * as React from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useModelGuards, useSaveModelGuards } from '@/api/hooks';
import {
  GUARD_KEYS,
  type GuardKey,
  type ModelGuardsValues,
  type ModelGuardValues,
  modelGuardsBody,
  modelGuardsToForm,
} from '@/api/views/settings';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { applyServerErrorsToList } from './guard-errors';

const GUARD_LABELS: Record<GuardKey, { title: string; help: string }> = {
  jev: { title: 'JEV guard', help: 'Judges tool results for injected instructions' },
  llmJudge: { title: 'LLM judge', help: 'A general model scores risky calls' },
  classifier: { title: 'Classifier', help: 'A small model labels content' },
};

const url = z.string().trim().url('Enter a full URL');
const unit = z.number().min(0, 'Between 0 and 1').max(1, 'Between 0 and 1');
const timeout = z
  .number()
  .int('Whole milliseconds')
  .positive('Above zero')
  .max(60_000, 'At most 60000 ms');

/** Mirrors the guard config schemas of `@bastion-mcp/guards` (jev, llm-judge, classifier). */
const SCHEMAS: Record<GuardKey, z.ZodType> = {
  jev: z
    .object({
      endpoint: url,
      model: z
        .string()
        .regex(/^jev-\d+\.\d+\.\d+$/, 'Pin an exact model version such as jev-1.13.0'),
      secret: z.string().trim().min(1, 'Name the org secret that holds the API key'),
      timeoutMs: timeout,
      warn: unit,
      quarantine: unit,
      block: unit,
    })
    .refine((v) => v.warn <= v.quarantine && v.quarantine <= v.block, {
      message: 'Thresholds must satisfy warn ≤ quarantine ≤ block',
    }),
  llmJudge: z.object({
    endpoint: url,
    model: z.string().trim().min(1, 'Name the model'),
    timeoutMs: timeout,
  }),
  classifier: z.object({
    endpoint: url,
    maliciousLabels: z
      .string()
      .refine((v) => v.split(',').some((s) => s.trim()), 'Give at least one malicious label'),
    threshold: unit,
    timeoutMs: timeout,
  }),
};

type FieldSpec = {
  name: keyof ModelGuardValues;
  label: string;
  type?: 'number';
  help?: string;
  step?: string;
};

const FIELDS: Record<GuardKey, FieldSpec[]> = {
  jev: [
    { name: 'endpoint', label: 'Endpoint' },
    { name: 'model', label: 'Model', help: 'An exact pinned version, never jev-latest' },
    { name: 'secret', label: 'API key secret', help: 'Name of the org secret' },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
    { name: 'warn', label: 'Warn from', type: 'number', step: '0.05' },
    { name: 'quarantine', label: 'Quarantine from', type: 'number', step: '0.05' },
    { name: 'block', label: 'Block from', type: 'number', step: '0.05' },
  ],
  llmJudge: [
    { name: 'endpoint', label: 'Endpoint', help: 'The full Chat Completions URL' },
    { name: 'model', label: 'Model' },
    { name: 'secret', label: 'API key secret (optional)', help: 'Name of the org secret' },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
  ],
  classifier: [
    { name: 'endpoint', label: 'Endpoint' },
    { name: 'maliciousLabels', label: 'Malicious labels', help: 'Comma separated, e.g. MALICIOUS' },
    { name: 'threshold', label: 'Threshold', type: 'number', step: '0.05' },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
    { name: 'secret', label: 'Credential secret (optional)', help: 'Name of the org secret' },
    { name: 'authHeader', label: 'Credential header' },
  ],
};

type Errors = Partial<Record<GuardKey, Record<string, string>>>;

const validate = (values: ModelGuardsValues): Errors => {
  const out: Errors = {};
  for (const key of GUARD_KEYS) {
    if (!values[key].enabled) continue;
    const parsed = SCHEMAS[key].safeParse(values[key]);
    if (parsed.success) continue;
    out[key] = {};
    for (const issue of parsed.error.issues)
      out[key][String(issue.path[0] ?? '_')] ??= issue.message;
  }
  return out;
};

export function ModelGuardsSection() {
  const q = useModelGuards();
  const save = useSaveModelGuards();
  const [cfg, setCfg] = React.useState<ModelGuardsValues | null>(null);
  const [errors, setErrors] = React.useState<Errors>({});
  React.useEffect(() => {
    if (q.data) setCfg(modelGuardsToForm(q.data));
  }, [q.data]);
  const set = (key: GuardKey, patch: Partial<ModelGuardValues>) =>
    setCfg((c) => (c ? { ...c, [key]: { ...c[key], ...patch } } : c));
  return (
    <QueryBoundary query={q}>
      {() =>
        cfg ? (
          <Card aria-label="Model guards" className="max-w-3xl gap-4">
            <CardHeader
              title="Model guards"
              subtitle="Optional models that add judgement to the deterministic guards"
            />
            {GUARD_KEYS.map((k) => (
              <fieldset
                key={k}
                className="m-0 flex flex-col gap-3 rounded-md border border-line p-3.5"
              >
                <legend className="px-1 text-label">{GUARD_LABELS[k].title}</legend>
                <label className="flex items-center gap-3">
                  <Switch
                    checked={cfg[k].enabled}
                    onCheckedChange={(v) => set(k, { enabled: v })}
                    aria-label={`Enable ${GUARD_LABELS[k].title}`}
                  />
                  <span className="text-caption text-muted">{GUARD_LABELS[k].help}</span>
                </label>
                {cfg[k].enabled ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {FIELDS[k].map((f) => (
                      <Field key={f.name} label={f.label} help={f.help} error={errors[k]?.[f.name]}>
                        {({ id, describedBy, invalid }) => (
                          <Input
                            id={id}
                            type={f.type}
                            step={f.step}
                            aria-describedby={describedBy}
                            aria-invalid={invalid}
                            value={String(cfg[k][f.name])}
                            onChange={(e) =>
                              set(k, {
                                [f.name]:
                                  f.type === 'number' ? Number(e.target.value) : e.target.value,
                              })
                            }
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                ) : null}
                {errors[k]?._ ? (
                  <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                    {errors[k]?._}
                  </p>
                ) : null}
              </fieldset>
            ))}
            <Button
              className="self-start"
              disabled={save.isPending}
              onClick={() => {
                const found = validate(cfg);
                setErrors(found);
                if (Object.keys(found).length > 0) return;
                save.mutate(modelGuardsBody(cfg), {
                  onSuccess: () => toast.success('Model guards saved'),
                  onError: (e) => setErrors(applyServerErrorsToList(e)),
                });
              }}
            >
              Save model guards
            </Button>
          </Card>
        ) : null
      }
    </QueryBoundary>
  );
}
