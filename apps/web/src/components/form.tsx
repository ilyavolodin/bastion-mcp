import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { type FieldValues, type UseFormReturn, useForm } from 'react-hook-form';
import { z } from 'zod';
import type { FormField as FieldDef } from '@/api/types';
import { cn } from '@/lib/cn';
import { Input } from './ui/input';
import { Label } from './ui/label';

/** Label, control, help and error text wired with ids so screen readers get all of them. */
export function Field({
  label,
  help,
  error,
  required,
  className,
  children,
}: {
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  className?: string;
  children: (a: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => React.ReactNode;
}) {
  const id = React.useId();
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
        {required ? <span className="text-coral-ink"> *</span> : null}
      </Label>
      {children({
        id,
        describedBy: [helpId, errId].filter(Boolean).join(' ') || undefined,
        invalid: Boolean(error),
      })}
      {help ? (
        <p id={helpId} className="m-0 text-caption text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="m-0 text-caption font-medium text-coral-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Builds a zod object from server-provided form fields (11.1 install form). */
export const fieldsSchema = (fields: FieldDef[]) =>
  z.object(
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.required
          ? z.string().trim().min(1, `${f.label} is required`)
          : z.string().optional().default(''),
      ]),
    ),
  );

export function useFieldsForm(fields: FieldDef[]): UseFormReturn<Record<string, string>> {
  return useForm<Record<string, string>>({
    resolver: zodResolver(fieldsSchema(fields)) as never,
    defaultValues: Object.fromEntries(fields.map((f) => [f.name, f.default ?? ''])),
  });
}

/** Renders the inputs for a list of server-provided fields (secrets are password inputs). */
export function FieldsInputs<T extends FieldValues = Record<string, string>>({
  fields,
  form,
}: {
  fields: FieldDef[];
  form: UseFormReturn<T>;
}) {
  return (
    <>
      {fields.map((f) => (
        <Field
          key={f.name}
          label={f.label}
          help={f.help}
          required={f.required}
          error={
            (form.formState.errors as Record<string, { message?: string } | undefined>)[f.name]
              ?.message
          }
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type={f.secret ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              placeholder={f.placeholder}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register(f.name as never)}
            />
          )}
        </Field>
      ))}
    </>
  );
}
