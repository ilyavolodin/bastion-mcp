import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { diffLines, diffWords } from '@/lib/diff';

type Props = {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
  /** `text` highlights changed words inline; `lines` is a code-style side-by-side line diff. */
  mode?: 'text' | 'lines';
  /** Tone of the right (new) side: `danger` for upstream drift, `neutral` for override previews. */
  tone?: 'danger' | 'accent';
  className?: string;
};

const Pane = ({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'plain' | 'danger' | 'accent';
  children: React.ReactNode;
}) => (
  <div
    className={cn(
      'flex min-w-0 flex-col gap-2 rounded-md p-3.5',
      tone === 'plain' && 'bg-sunken',
      tone === 'danger' && 'bg-coral-soft',
      tone === 'accent' && 'bg-tangerine-soft',
    )}
  >
    <span className={cn('text-overline', tone === 'danger' && '[color:var(--coral-ink)]', tone === 'accent' && '[color:var(--tangerine-ink)]')}>
      {label}
    </span>
    {children}
  </div>
);

/** Side-by-side definition diff with the changed segments highlighted (12.5, 13.6). */
export function DiffView({ left, right, leftLabel, rightLabel, mode = 'text', tone = 'danger', className }: Props) {
  const words = useMemo(() => (mode === 'text' ? diffWords(left, right) : []), [left, right, mode]);
  const rows = useMemo(() => (mode === 'lines' ? diffLines(left, right) : []), [left, right, mode]);

  if (mode === 'text') {
    return (
      <div className={cn('grid gap-3 sm:grid-cols-2', className)} data-testid="diff-view">
        <Pane label={leftLabel} tone="plain">
          <p className="m-0 font-mono text-[13px] leading-[21px]">
            {words
              .filter((w) => w.type !== 'add')
              .map((w, i) =>
                w.type === 'del' ? (
                  <mark key={`${i}-${w.text}`} data-diff="removed">{w.text}</mark>
                ) : (
                  <span key={`${i}-${w.text}`}>{w.text}</span>
                ),
              )}
          </p>
        </Pane>
        <Pane label={rightLabel} tone={tone === 'danger' ? 'danger' : 'accent'}>
          <p className="m-0 font-mono text-[13px] leading-[21px]">
            {words
              .filter((w) => w.type !== 'del')
              .map((w, i) =>
                w.type === 'add' ? (
                  <mark key={`${i}-${w.text}`} data-diff="added">{w.text}</mark>
                ) : (
                  <span key={`${i}-${w.text}`}>{w.text}</span>
                ),
              )}
          </p>
        </Pane>
      </div>
    );
  }

  return (
    <div className={cn('grid gap-3 sm:grid-cols-2', className)} data-testid="diff-view">
      {(['left', 'right'] as const).map((side) => (
        <Pane key={side} label={side === 'left' ? leftLabel : rightLabel} tone={side === 'left' ? 'plain' : 'accent'}>
          <pre className="m-0 overflow-x-auto font-mono text-[12px] leading-[20px]">
            {rows.map((r, i) => {
              const text = side === 'left' ? r.left : r.right;
              const changed =
                r.kind === 'changed' || (side === 'left' ? r.kind === 'removed' : r.kind === 'added');
              return (
                <span
                  key={`${side}-${i}`}
                  data-diff={changed ? (side === 'left' ? 'removed' : 'added') : undefined}
                  className={cn(
                    'block min-h-5 whitespace-pre',
                    changed && side === 'left' && 'bg-coral-soft text-coral-ink',
                    changed && side === 'right' && 'bg-mint-soft text-mint-ink',
                  )}
                >
                  {text ?? ' '}
                </span>
              );
            })}
          </pre>
        </Pane>
      ))}
    </div>
  );
}
