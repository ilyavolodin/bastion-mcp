import { Check } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

export type Step = { id: string; label: string };

/** Horizontal stepper (Catalog editor): done steps are mint ticks, the current step is the tangerine pill. */
export function Stepper({
  steps,
  current,
  onSelect,
  doneUpTo,
  label = 'Steps',
  readyId,
}: {
  steps: Step[];
  current: string;
  onSelect?: (id: string) => void;
  /** Index (exclusive) below which steps count as done; defaults to everything before `current`. */
  doneUpTo?: number;
  label?: string;
  /** A step that is ready to be taken (Publish after a passing test): marked and announced. */
  readyId?: string;
}) {
  const currentIndex = steps.findIndex((s) => s.id === current);
  const done = doneUpTo ?? currentIndex;
  // On a narrow screen the row scrolls: keep the current step (Publish is last) in view.
  const currentRef = React.useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever the current step changes
  React.useEffect(() => {
    currentRef.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [current]);
  return (
    <nav
      aria-label={label}
      className="overflow-x-auto rounded-lg bg-surface px-5 py-3.5 shadow-card"
    >
      <ol className="m-0 flex list-none items-center p-0 max-lg:min-w-max">
        {steps.map((s, k) => {
          const isDone = k < done && k !== currentIndex;
          const isCurrent = k === currentIndex;
          return (
            <li key={s.id} className="flex items-center gap-2 min-w-fit flex-1 last:flex-none">
              <button
                ref={isCurrent ? currentRef : undefined}
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
                    s.id === readyId && !isCurrent && 'bg-mint-soft text-mint-ink ring-2 ring-mint',
                  )}
                >
                  {isDone ? (
                    <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
                  ) : (
                    k + 1
                  )}
                  {isDone ? <span className="sr-only">done</span> : null}
                  {s.id === readyId && !isCurrent ? <span className="sr-only">ready</span> : null}
                </span>
                <span
                  className={cn(
                    'text-[13px] leading-[16px] max-lg:whitespace-nowrap',
                    isCurrent ? 'font-semibold text-ink' : 'font-medium',
                    !isDone && !isCurrent && 'text-muted',
                    s.id === readyId && !isCurrent && 'text-mint-ink',
                  )}
                >
                  {s.label}
                  {s.id === readyId && !isCurrent ? (
                    <span aria-hidden="true" className="ml-1.5 text-[11px] font-semibold">
                      ready
                    </span>
                  ) : null}
                </span>
              </button>
              {k < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'mx-1 h-0.5 min-w-1 flex-1 lg:mx-0.5',
                    isDone ? 'bg-mint' : 'bg-line',
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
