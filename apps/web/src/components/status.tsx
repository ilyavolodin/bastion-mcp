import { Check, CircleOff, Info, TriangleAlert, X } from 'lucide-react';
import type * as React from 'react';
import type { InstallationStatus as InstallationStatusValue } from '@/api/schema';
import { cn } from '@/lib/cn';

/**
 * Status is never colour alone (18.1, WCAG 1.4.1): every tone pairs a dot, an icon and a text label.
 * The `fg` colours are the contrast-checked `*-ink` tokens on their `*-soft` grounds.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'berry';

const TONES: Record<Tone, { dot: string; fg: string; bg: string; Icon: typeof Check }> = {
  ok: { dot: 'bg-mint', fg: 'text-mint-ink', bg: 'bg-mint-soft', Icon: Check },
  warn: { dot: 'bg-sun', fg: 'text-tangerine-ink', bg: 'bg-tangerine-soft', Icon: TriangleAlert },
  bad: { dot: 'bg-coral', fg: 'text-coral-ink', bg: 'bg-coral-soft', Icon: X },
  info: { dot: 'bg-sky', fg: 'text-sky-ink', bg: 'bg-sky-soft', Icon: Info },
  neutral: { dot: 'bg-line-strong', fg: 'text-muted', bg: 'bg-sunken', Icon: CircleOff },
  berry: { dot: 'bg-berry', fg: 'text-berry-ink', bg: 'bg-berry-soft', Icon: Info },
};

export const toneClasses = (tone: Tone) => TONES[tone];

type DotProps = { tone: Tone; label: string; className?: string; hideLabel?: boolean };

/** Dot, icon and label inline (installation tiles, checks). */
export function StatusDot({ tone, label, className, hideLabel }: DotProps) {
  const { dot, fg, Icon } = TONES[tone];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-caption font-medium', fg, className)}
    >
      <span className={cn('size-2 rounded-full', dot)} aria-hidden="true" />
      <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
      <span className={cn(hideLabel && 'sr-only')}>{label}</span>
    </span>
  );
}

/** The same, as a soft pill (page headers, drawers). */
export function StatusPill({ tone, label, className }: DotProps) {
  const { dot, fg, bg, Icon } = TONES[tone];
  return (
    <span
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-caption font-semibold',
        bg,
        fg,
        className,
      )}
    >
      <span className={cn('size-2 rounded-full', dot)} aria-hidden="true" />
      <Icon className="size-3" strokeWidth={2.25} aria-hidden="true" />
      {label}
    </span>
  );
}

export const INSTALLATION_STATUS: Record<InstallationStatusValue, { tone: Tone; label: string }> = {
  ready: { tone: 'ok', label: 'Ready' },
  needs_setup: { tone: 'warn', label: 'Needs setup' },
  reconnect_required: { tone: 'warn', label: 'Reconnect required' },
  error: { tone: 'bad', label: 'Not starting' },
  disabled: { tone: 'neutral', label: 'Turned off' },
};

export function InstallationStatus({
  status,
  variant = 'dot',
}: {
  status: InstallationStatusValue;
  variant?: 'dot' | 'pill';
}) {
  const s = INSTALLATION_STATUS[status];
  return variant === 'pill' ? (
    <StatusPill tone={s.tone} label={s.label} />
  ) : (
    <StatusDot tone={s.tone} label={s.label} />
  );
}

/** Error share to a health tone (Observability health map). */
export const healthTone = (errorRate: number): Tone =>
  errorRate > 0.1 ? 'bad' : errorRate > 0.03 ? 'warn' : 'ok';

export const HEALTH_LABEL: Record<Tone, string> = {
  ok: 'Healthy',
  warn: 'Some errors',
  bad: 'Failing',
  info: 'Info',
  neutral: 'Idle',
  berry: 'Review',
};

export type Outcome = import('@/api/schema').CallOutcome;
export const OUTCOME: Record<
  Outcome,
  { label: string; bg: string; fg: string; bar: string; strip: string }
> = {
  ok: {
    label: 'Succeeded',
    bg: 'bg-mint-soft',
    fg: 'text-mint-ink',
    bar: 'bg-mint',
    strip: 'var(--mint)',
  },
  tool_error: {
    label: 'Tool error',
    bg: 'bg-tangerine-soft',
    fg: 'text-tangerine-ink',
    bar: 'bg-sun',
    strip: 'var(--sun)',
  },
  error: {
    label: 'Upstream error',
    bg: 'bg-tangerine-soft',
    fg: 'text-tangerine-ink',
    bar: 'bg-sun',
    strip: 'var(--sun)',
  },
  denied: {
    label: 'Denied by policy',
    bg: 'bg-berry-soft',
    fg: 'text-berry-ink',
    bar: 'bg-berry',
    strip: 'var(--berry-ink)',
  },
  blocked: {
    label: 'Blocked by guard',
    bg: 'bg-coral-soft',
    fg: 'text-coral-ink',
    bar: 'bg-coral',
    strip: 'var(--coral-ink)',
  },
  rate_limited: {
    label: 'Rate limited',
    bg: 'bg-sky-soft',
    fg: 'text-sky-ink',
    bar: 'bg-sky',
    strip: 'var(--sky)',
  },
  input_required: {
    label: 'Needs input',
    bg: 'bg-sky-soft',
    fg: 'text-sky-ink',
    bar: 'bg-sky',
    strip: 'var(--sky)',
  },
};

/** Outcome badge: dot plus label, tinted ground (Activity list and drawer). */
export function OutcomeBadge({ outcome, label }: { outcome: Outcome; label?: string }) {
  const o = OUTCOME[outcome];
  return (
    <span
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-caption font-semibold',
        o.bg,
        o.fg,
      )}
    >
      <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
      {label ?? o.label}
    </span>
  );
}

export function IconBadge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>{children}</span>
  );
}
