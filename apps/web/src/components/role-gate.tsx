import { Link } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import type * as React from 'react';
import type { UiRole } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { DENIED, type NavSection } from '@/lib/roles';
import { Button } from './ui/button';

/** Renders children only for the listed UI roles (an element that other roles must not see). */
export function RoleGate({
  roles,
  children,
  fallback = null,
}: {
  roles: readonly UiRole[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { role } = useAuth();
  return <>{roles.includes(role) ? children : fallback}</>;
}

/** The "Not in this role's navigation" screen (design: Observability, Security, Catalog, Access, Settings). */
export function NotInNavigation({ section }: { section: NavSection }) {
  const copy = DENIED[section];
  return (
    <section className="mx-auto my-20 flex max-w-md flex-col items-center gap-3 text-center">
      <Lock className="size-10 text-muted" strokeWidth={1.5} aria-hidden="true" />
      <h1 className="m-0 text-[22px] leading-[30px] font-semibold">{copy.title}</h1>
      {copy.body ? <p className="m-0 text-muted">{copy.body}</p> : null}
      <Button asChild variant="soft">
        <Link to={copy.to}>{copy.linkLabel}</Link>
      </Button>
    </section>
  );
}

/** Route-level guard: wraps a screen so a role outside its navigation gets the screen above. */
export function Guard({ section, children }: { section: NavSection; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(section) ? children : <NotInNavigation section={section} />;
}
