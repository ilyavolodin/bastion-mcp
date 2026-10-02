import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export type Step = { id: string; label: string };

/** Horizontal stepper (Catalog editor): done steps are mint ticks, the current step is the tangerine pill. */
export function Stepper({
  steps,
  current,
  onSelect,
  doneUpTo,
  label = 'Steps',
}: {
  steps: Step[];
  current: string;
  onSelect?: (id: string) => void;
  /** Index (exclusive) below which steps count as done; defaults to everything before `current`. */
  doneUpTo?: number;
  label?: string;
}) {
  const currentIndex = steps.findIndex((s) => s.id === current);
  const done = doneUpTo ?? currentIndex;
  return (
    <nav aria-label={label} className="overflow-x-auto rounded-lg bg-surface px-5 py-3.5 shadow-card">
      <ol className="m-0 flex min-w-max list-none items-center p-0">
        {steps.map((s, k) => {
          const isDone = k < done && k !== currentIndex;
          const isCurrent = k === currentIndex;
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
              <button
                type="button"
                onClick={() => onSelect?.(s.id)}
                aria-current={isCurrent ? 'step' : undefined}
                className="flex items-center gap-2 rounded-md py-1 text-left"
              >
                <span
                  className={cn(
                    'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold',
                    isDone && 'bg-mint-soft text-mint-ink',
                    isCurrent && 'bg-grad-tangerine text-on-bright shadow-glow',
                    !isDone && !isCurrent && 'bg-sunken text-muted',
                  )}
                >
                  {isDone ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : k + 1}
                  {isDone ? <span className="sr-only">done</span> : null}
                </span>
                <span
                  className={cn(
                    'whitespace-nowrap text-[13px] leading-[18px]',
                    isCurrent ? 'font-semibold text-ink' : 'font-medium',
                    !isDone && !isCurrent && 'text-muted',
                  )}
                >
                  {s.label}
                </span>
              </button>
              {k < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn('mx-2 h-0.5 min-w-2 flex-1', isDone ? 'bg-mint' : 'bg-line')}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
