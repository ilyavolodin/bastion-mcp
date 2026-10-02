import { Link } from '@tanstack/react-router';
import { ChevronLeft, Search } from 'lucide-react';
import type * as React from 'react';
import { useInstallations } from '@/api/hooks';
import { NotificationsBell } from '@/components/shell/notifications';
import { usePalette } from '@/components/shell/palette-context';
import { cn } from '@/lib/cn';

export function SearchTrigger({ className }: { className?: string }) {
  const { setOpen } = usePalette();
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Search servers, tools, people and settings"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        'flex h-11 w-[340px] max-w-full items-center gap-2.5 rounded-md bg-surface px-3.5 text-left text-[14px] text-muted shadow-card max-lg:w-auto max-lg:min-w-11 max-lg:justify-center max-lg:px-0',
        className,
      )}
    >
      <Search className="size-[18px] shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate max-lg:hidden">Search servers, tools, people</span>
      <kbd className="rounded-sm bg-sunken px-1.5 py-0.5 font-sans text-[11px] font-semibold max-lg:hidden">
        {mac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}

/** Setup badge in the header: installations that still need the user's input (11.5). */
function SetupBadge() {
  const { data } = useInstallations();
  const n = (data ?? []).filter((i) => i.status === 'needs_setup' || i.status === 'reconnect_required').length;
  if (n === 0) return null;
  return (
    <Link
      to="/servers"
      className="inline-flex h-11 items-center gap-2 rounded-md bg-tangerine-soft px-3.5 text-label text-tangerine-ink no-underline hover:text-tangerine-ink max-md:hidden"
    >
      <span className="size-2 rounded-full bg-sun" aria-hidden="true" />
      {n} to set up
    </Link>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  badge,
  icon,
  className,
  tools = true,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { to: string; label: string };
  badge?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  tools?: boolean;
}) {
  return (
    <>
      {back ? (
        <Link
          to={back.to}
          className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-muted no-underline hover:text-ink"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      <header className={cn('flex flex-wrap items-center gap-4', className)}>
        {icon}
        <div className="min-w-0 flex-[1_1_340px]">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-page-title">{title}</h1>
            {badge}
          </div>
          {subtitle ? <p className="m-0 mt-0.5 text-muted">{subtitle}</p> : null}
        </div>
        {actions}
        {tools ? (
          <div className="flex items-center gap-2.5">
            <SetupBadge />
            <SearchTrigger />
            <NotificationsBell />
          </div>
        ) : null}
      </header>
    </>
  );
}
