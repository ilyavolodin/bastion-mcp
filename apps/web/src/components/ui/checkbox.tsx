import * as Primitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof Primitive.Root>,
  React.ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ className, ...props }, ref) => (
  <Primitive.Root
    ref={ref}
    className={cn(
      'flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-surface data-[state=checked]:border-tangerine data-[state=checked]:bg-tangerine',
      className,
    )}
    {...props}
  >
    <Primitive.Indicator>
      <Check className="size-3.5 text-on-bright" strokeWidth={3} aria-hidden="true" />
    </Primitive.Indicator>
  </Primitive.Root>
));
Checkbox.displayName = 'Checkbox';
