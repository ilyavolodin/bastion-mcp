import { Link } from '@tanstack/react-router';
import { Lock, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { avatarColor, initials } from '@/lib/format';
import type { Tone } from './status';
import { toneClasses } from './status';

// --- Card -------------------------------------------------------------------------------------------
export function Card({
  className,
  as: Tag = 'section',
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' | 'article' | 'aside' }) {
  return (
    <Tag
      className={cn('flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
  titleClassName,
  id,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
  id?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <h2 id={id} className={cn('m-0 min-w-0 flex-1 text-card-title', titleClassName)}>
        {title}
        {subtitle ? <span className="ml-2 text-caption font-normal text-muted">{subtitle}</span> : null}
      </h2>
      {actions}
    </div>
  );
}

// --- Tag and chip -------------------------------------------------------------------------------------
export function Tag({
  tone = 'neutral',
  icon,
  className,
  children,
  title,
}: {
  tone?: Tone | 'surface';
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  const t = tone === 'surface' ? null : toneClasses(tone);
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-[22px] items-center gap-1 rounded-sm px-2 text-[11px] font-semibold',
        t ? [t.bg, t.fg] : 'bg-surface text-ink',
        tone === 'neutral' && 'bg-sunken text-ink',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export function Chip({
  tone = 'neutral',
  icon,
  onRemove,
  removeLabel,
  dashed,
  className,
  children,
}: {
  tone?: Tone;
  icon?: React.ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  dashed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const t = toneClasses(tone);
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-caption font-medium',
        tone === 'neutral' ? 'bg-sunken text-ink' : [t.bg, t.fg, 'font-semibold'],
        dashed && 'border border-dashed border-line-strong bg-transparent text-muted',
        className,
      )}
    >
      {icon}
      {children}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel ?? 'Remove'}
          onClick={onRemove}
          className="-mr-1 inline-flex size-5 items-center justify-center rounded-full hover:bg-line"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

// --- Avatars ---------------------------------------------------------------------------------------------
export function Avatar({
  name,
  size = 24,
  color,
  className,
  dashed,
}: {
  name: string;
  size?: number;
  color?: string;
  className?: string;
  dashed?: boolean;
}) {
  return (
    <span
      title={name}
      role="img"
      aria-label={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.38)),
        background: dashed ? 'transparent' : (color ?? avatarColor(name)),
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-on-bright',
        dashed && 'border-[1.5px] border-dashed border-line-strong text-ink',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/** Overlapping avatars (approval previews, auto-install preview). */
export function AvatarStrip({
  names,
  size = 28,
  extra,
}: {
  names: string[];
  size?: number;
  extra?: number;
}) {
  return (
    <div className="flex items-center" data-testid="avatar-strip">
      {names.map((n, i) => (
        <Avatar
          key={`${n}-${i}`}
          name={n}
          size={size}
          className={cn('border-2 border-surface', i > 0 && '-ml-1.5')}
        />
      ))}
      {extra && extra > 0 ? <span className="ml-2 text-caption text-muted">+ {extra}</span> : null}
    </div>
  );
}

/** Letter avatar for servers and plugins. */
export function ServerIcon({
  letter,
  color,
  size = 40,
  square,
}: {
  letter: string;
  color: string;
  size?: number;
  square?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.38) }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold text-on-bright',
        square ? 'rounded-[12px]' : 'rounded-full',
      )}
    >
      {letter}
    </span>
  );
}

// --- Misc layout -------------------------------------------------------------------------------------------
export function Overline({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn('text-overline', className)}>{children}</span>;
}

/** A pill-shaped segmented control (time ranges, scopes, category chips). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex gap-1 rounded-md bg-line p-1', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-[13px] font-medium',
            o.value === value ? 'bg-grad-tangerine text-on-bright' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LinkText({
  to,
  children,
  className,
  params,
  search,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
}) {
  return (
    <Link
      to={to}
      {...(params ? { params } : {})}
      {...(search ? { search } : {})}
      className={cn('text-label text-sky-ink no-underline hover:text-ink', className)}
    >
      {children}
    </Link>
  );
}

export function ReadOnlyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md bg-sunken px-3.5 py-3">
      <Lock className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="flex-1 text-[13px] text-muted">{children}</span>
    </div>
  );
}

export function Legend({
  items,
}: {
  items: { label: string; color: string; shape?: 'dot' | 'line' | 'bar' | 'triangle' }[];
}) {
  return (
    <>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-caption text-muted">
          {i.shape === 'triangle' ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 0 10 9H0z" fill={i.color} />
            </svg>
          ) : (
            <span
              aria-hidden="true"
              style={{ background: i.color }}
              className={cn(
                i.shape === 'line' && 'h-[3px] w-3.5 rounded-sm',
                i.shape === 'bar' && 'h-2.5 w-2 rounded-[2px]',
                (!i.shape || i.shape === 'dot') && 'size-2.5 rounded-[3px]',
              )}
            />
          )}
          {i.label}
        </span>
      ))}
    </>
  );
}
