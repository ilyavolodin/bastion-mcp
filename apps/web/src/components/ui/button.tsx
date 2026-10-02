import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-label no-underline transition-[background,box-shadow,opacity] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-grad-tangerine text-on-bright shadow-glow hover:text-on-bright hover:brightness-[1.03]',
        outline: 'border border-line-strong bg-surface text-ink hover:bg-sunken hover:text-ink',
        soft: 'bg-tangerine-soft text-tangerine-ink hover:text-tangerine-ink hover:brightness-[0.97]',
        danger: 'bg-coral text-on-bright hover:text-on-bright hover:brightness-[1.03]',
        ghost: 'bg-transparent text-ink hover:bg-sunken hover:text-ink',
        card: 'bg-surface text-ink shadow-card hover:text-ink',
        sunken: 'bg-sunken text-ink hover:text-ink',
      },
      size: {
        default: 'h-11 px-[18px]',
        sm: 'h-10 px-3.5 text-[13px]',
        xs: 'h-9 px-3 text-[13px]',
        lg: 'h-12 px-5 text-[15px] font-semibold',
        icon: 'size-11',
        'icon-sm': 'size-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        {...(asChild ? {} : { type: type ?? 'button' })}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
