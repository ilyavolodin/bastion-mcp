import { Command as Primitive } from 'cmdk';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Command = React.forwardRef<
  React.ComponentRef<typeof Primitive>,
  React.ComponentPropsWithoutRef<typeof Primitive>
>(({ className, ...props }, ref) => (
  <Primitive ref={ref} className={cn('flex flex-col overflow-hidden rounded-lg bg-surface', className)} {...props} />
));
Command.displayName = 'Command';

export const CommandInput = React.forwardRef<
  React.ComponentRef<typeof Primitive.Input>,
  React.ComponentPropsWithoutRef<typeof Primitive.Input>
>(({ className, ...props }, ref) => (
  <Primitive.Input
    ref={ref}
    className={cn('h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-ink outline-none placeholder:text-muted', className)}
    {...props}
  />
));
CommandInput.displayName = 'CommandInput';

export const CommandList = React.forwardRef<
  React.ComponentRef<typeof Primitive.List>,
  React.ComponentPropsWithoutRef<typeof Primitive.List>
>(({ className, ...props }, ref) => (
  <Primitive.List ref={ref} className={cn('max-h-[360px] overflow-y-auto p-2', className)} {...props} />
));
CommandList.displayName = 'CommandList';

export const CommandEmpty = (props: React.ComponentPropsWithoutRef<typeof Primitive.Empty>) => (
  <Primitive.Empty className="px-3 py-6 text-center text-label text-muted" {...props} />
);

export const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof Primitive.Group>,
  React.ComponentPropsWithoutRef<typeof Primitive.Group>
>(({ className, ...props }, ref) => (
  <Primitive.Group
    ref={ref}
    className={cn('[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-overline', className)}
    {...props}
  />
));
CommandGroup.displayName = 'CommandGroup';

export const CommandItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(({ className, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn('flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-label data-[selected=true]:bg-tangerine-soft data-[selected=true]:text-tangerine-ink', className)}
    {...props}
  />
));
CommandItem.displayName = 'CommandItem';
