import * as Primitive from '@radix-ui/react-tabs';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Tabs = Primitive.Root;

/** Underlined section tabs (Installation detail, Access): active tab carries a 3px tangerine bar. */
export const TabsList = React.forwardRef<
  React.ComponentRef<typeof Primitive.List>,
  React.ComponentPropsWithoutRef<typeof Primitive.List>
>(({ className, ...props }, ref) => (
  <Primitive.List
    ref={ref}
    className={cn('flex flex-wrap gap-1 border-b border-line', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(({ className, ...props }, ref) => (
  <Primitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-11 items-center gap-1.5 px-3.5 text-label text-muted hover:text-ink data-[state=active]:font-semibold data-[state=active]:text-ink data-[state=active]:shadow-[inset_0_-3px_0_var(--tangerine)] focus-visible:shadow-[var(--focus-ring)]',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, ...props }, ref) => (
  <Primitive.Content ref={ref} className={cn('mt-6', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';
