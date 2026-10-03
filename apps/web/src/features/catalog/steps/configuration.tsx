import { Plus } from 'lucide-react';
import * as React from 'react';
import { Card, CardHeader } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { type ArgDraft, type BindingDraft, emptyVariable, type VariableDraft } from '../draft';
import { type StepProps, setSpec } from './props';
import { ArgRow, BindingRow, ReferenceList, VariableRow } from './rows';

const newEnv = (): BindingDraft => ({ name: '', value: '', secret: false });
const newArg = (): ArgDraft => ({ kind: 'positional', name: '', value: '', secret: false });

export function ConfigurationStep({ draft, onChange, readOnly }: StepProps) {
  const spec = draft.spec;
  const vars = spec.variables;
  const listId = React.useId();
  const updateVar = (i: number, next: VariableDraft) =>
    onChange(setSpec(draft, { variables: vars.map((v, k) => (k === i ? next : v)) }));
  const isPackage = spec.type === 'package';
  return (
    <>
      <Card aria-label="Configuration" className="gap-4">
        <CardHeader
          title="Configuration"
          subtitle="Variables people fill in when they install"
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              onClick={() => onChange(setSpec(draft, { variables: [...vars, emptyVariable()] }))}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add variable
            </Button>
          }
        />
        <p className="m-0 text-caption text-muted">
          Names use letters, digits and underscore. Refer to a variable as {'{{var.NAME}}'}
          {isPackage ? ' in an environment variable or argument below' : ' in the URL or a header'}.
        </p>
        {vars.length === 0 ? (
          <p className="m-0 text-muted">
            No variables: people can install without filling anything in.
          </p>
        ) : null}
        {vars.map((v, i) => (
          <VariableRow
            key={i}
            row={v}
            index={i}
            readOnly={readOnly}
            onChange={(next) => updateVar(i, next)}
            onRemove={() => onChange(setSpec(draft, { variables: vars.filter((_, k) => k !== i) }))}
          />
        ))}
      </Card>
      {isPackage ? (
        <>
          <Card aria-label="Environment variables" className="gap-4">
            <CardHeader
              title="Environment variables"
              subtitle="Set for the server process"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => onChange(setSpec(draft, { envVars: [...spec.envVars, newEnv()] }))}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add environment variable
                </Button>
              }
            />
            <p className="m-0 text-caption text-muted">
              A fixed value, a variable ({'{{var.NAME}}'}) or a secret. Tick Secret for a token or
              key: Authentication says who provides it.
            </p>
            <ReferenceList id={listId} spec={spec} />
            {spec.envVars.length === 0 ? (
              <p className="m-0 text-muted">No environment variables.</p>
            ) : null}
            {spec.envVars.map((row, i) => (
              <BindingRow
                key={i}
                kind="env"
                index={i}
                row={row}
                spec={spec}
                mode={spec.authMode}
                readOnly={readOnly}
                listId={listId}
                onChange={(next) =>
                  onChange(
                    setSpec(draft, { envVars: spec.envVars.map((r, k) => (k === i ? next : r)) }),
                  )
                }
                onRemove={() =>
                  onChange(setSpec(draft, { envVars: spec.envVars.filter((_, k) => k !== i) }))
                }
              />
            ))}
          </Card>
          <Card aria-label="Arguments" className="gap-4">
            <CardHeader
              title="Arguments"
              subtitle="Passed to the server on the command line"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => onChange(setSpec(draft, { args: [...spec.args, newArg()] }))}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add argument
                </Button>
              }
            />
            {spec.args.length === 0 ? <p className="m-0 text-muted">No arguments.</p> : null}
            {spec.args.map((row, i) => (
              <ArgRow
                key={i}
                index={i}
                row={row}
                spec={spec}
                mode={spec.authMode}
                readOnly={readOnly}
                listId={listId}
                onChange={(next) =>
                  onChange(setSpec(draft, { args: spec.args.map((r, k) => (k === i ? next : r)) }))
                }
                onRemove={() =>
                  onChange(setSpec(draft, { args: spec.args.filter((_, k) => k !== i) }))
                }
              />
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}
