import { Link } from '@tanstack/react-router';
import type * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from './ui/button';

type Action = {
  label: string;
  onClick?: () => void;
  to?: string;
  search?: Record<string, unknown>;
};

/**
 * "One next action per state" (18.1): every empty state, setup banner and error names one thing to do and
 * offers its button.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  headingLevel = 2,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: Action;
  className?: string;
  headingLevel?: 1 | 2 | 3;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <span className="flex size-12 items-center justify-center rounded-full bg-sunken text-muted [&_svg]:size-6">
          {icon}
        </span>
      ) : null}
      <Heading className="m-0 text-[20px] leading-[28px] font-semibold">{title}</Heading>
      {description ? <p className="m-0 text-muted">{description}</p> : null}
      {action ? (
        action.to ? (
          <Button asChild>
            <Link to={action.to} {...(action.search ? { search: action.search } : {})}>
              {action.label}
            </Link>
          </Button>
        ) : (
          <Button onClick={action.onClick}>{action.label}</Button>
        )
      ) : null}
    </div>
  );
}
