import * as React from 'react';
import { cn } from '@/lib/cn';

const field =
  'w-full rounded-md border border-line-strong bg-surface px-3 text-[14px] text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-coral-ink';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(field, 'h-11', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-24 py-2.5 leading-[22px]', className)} {...props} />
));
Textarea.displayName = 'Textarea';

/** Native select styled like an input: keyboard and screen-reader support for free. */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(field, 'h-11 appearance-none bg-no-repeat pr-9', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';
