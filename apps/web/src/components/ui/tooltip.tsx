import * as Primitive from '@radix-ui/react-tooltip';
import type * as React from 'react';
import { cn } from '@/lib/cn';

export const TooltipProvider = Primitive.Provider;

/** A text tooltip around one focusable child. */
export function Tip({
  label,
  children,
  side = 'top',
}: {
  label: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <Primitive.Root delayDuration={200}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-caption text-canvas shadow-float',
          )}
        >
          {label}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
