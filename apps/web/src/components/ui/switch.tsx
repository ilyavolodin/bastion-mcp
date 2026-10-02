import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'relative inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full border border-line-strong bg-sunken transition-colors disabled:opacity-50 data-[state=checked]:border-tangerine data-[state=checked]:bg-tangerine',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-4 translate-x-[3px] rounded-full bg-ink-muted shadow transition-transform data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-white" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
