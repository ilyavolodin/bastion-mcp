import { Link, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Globe,
  House,
  Layers,
  type LucideIcon,
  Plug,
  Server,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Users,
  LineChart,
} from 'lucide-react';
import { useAuth } from '@/auth/auth';
import { cn } from '@/lib/cn';
import {
  ACTIVITY_SCOPE,
  GROUP_LABEL,
  type NavGroup,
  type NavSection,
  SECTIONS,
  sectionForPath,
  visibleSections,
} from '@/lib/roles';
import { UserMenu } from './user-menu';

export const SECTION_ICON: Record<NavSection, LucideIcon> = {
  home: House,
  store: ShoppingBag,
  servers: Server,
  activity: Activity,
  plugins: Plug,
  observability: LineChart,
  security: ShieldCheck,
  catalog: Layers,
  registry: Globe,
  access: Users,
  settings: SlidersHorizontal,
};

export function BastionMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      stroke="var(--tangerine-ink)"
      strokeWidth="1.5"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M14 2.5 24 6.5v7.2c0 5.6-4.2 10.3-10 11.8C8.2 24 4 19.3 4 13.7V6.5L14 2.5z" />
      <path d="M9 11.5h10M9 15.5h10M14 7.5v13" />
    </svg>
  );
}

export function NavLinks({
  onNavigate,
  collapsible = true,
  only,
}: {
  onNavigate?: () => void;
  collapsible?: boolean;
  only?: (s: NavSection) => boolean;
}) {
  const { role, me } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = sectionForPath(path);
  const sections = visibleSections(role, me.capabilities).filter((s) => (only ? only(s) : true));
  const groups = (['workspace', 'oversight', 'manage'] as NavGroup[]).filter((g) =>
    sections.some((s) => SECTIONS[s].group === g),
  );
  const hide = collapsible ? 'max-[1279px]:hidden' : '';
  return (
    <>
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-1.5">
          <span className={cn('px-3 pb-0.5 pt-4 text-overline first:pt-1', hide)}>{GROUP_LABEL[g]}</span>
          {sections
            .filter((s) => SECTIONS[s].group === g)
            .map((s) => {
              const Icon = SECTION_ICON[s];
              const on = s === active;
              return (
                <Link
                  key={s}
                  to={SECTIONS[s].path}
                  onClick={onNavigate}
                  aria-current={on ? 'page' : undefined}
                  title={SECTIONS[s].label}
                  className={cn(
                    'flex h-11 items-center gap-3 rounded-md px-3 text-label no-underline',
                    collapsible && 'max-[1279px]:justify-center max-[1279px]:px-0',
                    on
                      ? 'bg-grad-tangerine text-on-bright shadow-glow hover:text-on-bright'
                      : 'text-ink hover:bg-sunken hover:text-ink',
                  )}
                >
                  <Icon
                    className={cn('size-[18px] shrink-0', on ? 'text-on-bright' : 'text-muted')}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className={cn('flex-1', hide)}>{SECTIONS[s].label}</span>
                  {s === 'activity' ? (
                    <span className={cn('text-[11px]', on ? 'text-on-bright' : 'text-muted', hide)}>
                      {ACTIVITY_SCOPE[role].nav}
                    </span>
                  ) : null}
                </Link>
              );
            })}
        </div>
      ))}
    </>
  );
}

/** Left navigation: the 11 sections of 18.2 filtered by role; icons only from 768 to 1279 px. */
export function Sidebar() {
  return (
    <nav
      aria-label="Main"
      className="sticky top-0 z-20 hidden h-screen w-[248px] shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-line bg-surface px-3.5 py-5 md:flex max-[1279px]:w-[72px] max-[1279px]:px-2.5"
    >
      <div className="flex items-center gap-2.5 px-2.5 pb-4 pt-1 max-[1279px]:justify-center max-[1279px]:px-0">
        <BastionMark />
        <span className="text-[18px] leading-6 font-semibold tracking-[-0.01em] max-[1279px]:hidden">Bastion</span>
      </div>
      <NavLinks />
      <div className="min-h-6 flex-1" />
      <UserMenu collapsed />
    </nav>
  );
}
