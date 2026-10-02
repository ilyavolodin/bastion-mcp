import * as Primitive from '@radix-ui/react-popover';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, sideOffset = 8, align = 'end', ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn(
        'z-50 w-[360px] max-w-[calc(100vw-32px)] rounded-lg bg-surface p-4 shadow-float',
        className,
      )}
      {...props}
    />
  </Primitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';
