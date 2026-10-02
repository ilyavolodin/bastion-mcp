import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const Overlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]', className)}
    {...props}
  />
));
Overlay.displayName = 'DialogOverlay';

type ContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** `drawer` slides in from the right (Store detail, Activity detail on narrow screens). */
  placement?: 'center' | 'drawer';
  title: string;
  description?: string;
  hideTitle?: boolean;
};

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  ContentProps
>(({ className, children, placement = 'center', title, description, hideTitle, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content
      ref={ref}
      {...(description ? {} : { 'aria-describedby': undefined })}
      className={cn(
        'fixed z-50 flex flex-col gap-4 bg-surface shadow-float',
        placement === 'center' &&
          'left-1/2 top-1/2 max-h-[90vh] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg p-6',
        placement === 'drawer' &&
          'inset-y-0 right-0 w-full max-w-[440px] overflow-y-auto rounded-l-lg p-6 max-sm:max-w-full',
        className,
      )}
      {...props}
    >
      <div className={cn('flex items-start gap-3', hideTitle && 'sr-only')}>
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="text-card-title">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-0.5 text-caption text-muted">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
      </div>
      {children}
      <DialogPrimitive.Close
        aria-label="Close"
        className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-md bg-sunken text-ink hover:bg-line"
      >
        <X className="size-4" aria-hidden="true" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';
