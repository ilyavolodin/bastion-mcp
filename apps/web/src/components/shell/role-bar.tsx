import { Eye } from 'lucide-react';
import type { UiRole } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { cn } from '@/lib/cn';

const OPTIONS: { id: UiRole | 'actual'; label: string; dot: string }[] = [
  { id: 'actual', label: 'My role', dot: 'var(--gradient-spectrum)' },
  { id: 'admin', label: 'Admin', dot: 'var(--tangerine)' },
  { id: 'manager', label: 'Manager', dot: 'var(--sky)' },
  { id: 'member', label: 'Member', dot: 'var(--mint)' },
  { id: 'auditor', label: 'Auditor', dot: 'var(--berry)' },
];

/** Dev-only role preview (`?rolePreview=1`), the design review's "Role preview bar" made switchable. */
export function RoleBar() {
  const { role, actualRole, setPreviewRole } = useAuth();
  const current = role === actualRole ? 'actual' : role;
  return (
    <div
      role="region"
      aria-label="Role preview"
      className="flex flex-wrap items-center gap-4 border-b border-line bg-surface px-6 py-2.5"
    >
      <div className="flex min-w-[280px] flex-1 items-center gap-3">
        <Eye className="size-[18px] text-tangerine-ink" aria-hidden="true" />
        <span className="text-overline">Role preview</span>
        <span className="text-caption text-muted">
          {current === 'actual' ? `Showing your own role (${actualRole}).` : `Showing only what a ${role} sees.`}
        </span>
      </div>
      <div className="flex gap-1 rounded-md bg-sunken p-1">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={o.id === current}
            onClick={() => setPreviewRole(o.id === 'actual' ? null : (o.id as UiRole))}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-sm px-3.5 text-[13px] font-medium',
              o.id === current ? 'bg-surface text-ink shadow-[0_0_0_1.5px_var(--tangerine-ink)]' : 'text-muted',
            )}
          >
            <span className="size-2 rounded-full" style={{ background: o.dot }} aria-hidden="true" />
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
