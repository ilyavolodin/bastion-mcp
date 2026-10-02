import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useMe } from '@/api/hooks';
import type { Me, ThemePref, UiRole } from '@/api/views/session';
import { ProblemScreen } from '@/components/problem';
import { Skeleton } from '@/components/ui/skeleton';
import { canSee, type NavSection, uiRole } from '@/lib/roles';
import { applyTheme, cachedTheme } from '@/lib/theme';

type AuthValue = {
  me: Me;
  /** The role the UI renders for: the real role, or the dev-only preview override. */
  role: UiRole;
  actualRole: UiRole;
  previewEnabled: boolean;
  setPreviewRole: (role: UiRole | null) => void;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  can: (section: NavSection) => boolean;
};

const AuthContext = React.createContext<AuthValue | null>(null);

const PREVIEW_FLAG = 'bastion.rolePreview';
const PREVIEW_ROLE = 'bastion.rolePreview.role';

/** The preview switch is dev-only and off unless the URL carries `?rolePreview=1` (sticky per tab). */
export function readPreviewEnabled(search = window.location.search): boolean {
  try {
    const p = new URLSearchParams(search).get('rolePreview');
    if (p === '1') sessionStorage.setItem(PREVIEW_FLAG, '1');
    if (p === '0') {
      sessionStorage.removeItem(PREVIEW_FLAG);
      sessionStorage.removeItem(PREVIEW_ROLE);
    }
    return sessionStorage.getItem(PREVIEW_FLAG) === '1';
  } catch {
    return false;
  }
}

const readPreviewRole = (): UiRole | null => {
  try {
    const v = sessionStorage.getItem(PREVIEW_ROLE);
    return v === 'admin' || v === 'manager' || v === 'member' || v === 'auditor' ? v : null;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const meQuery = useMe();
  const qc = useQueryClient();
  const [previewEnabled] = React.useState(() => readPreviewEnabled());
  const [preview, setPreview] = React.useState<UiRole | null>(() =>
    readPreviewEnabled() ? readPreviewRole() : null,
  );
  const [localTheme, setLocalTheme] = React.useState<ThemePref | null>(null);

  const me = meQuery.data;
  const theme: ThemePref = localTheme ?? cachedTheme() ?? 'light';
  React.useEffect(() => applyTheme(theme), [theme]);

  const setPreviewRole = React.useCallback((role: UiRole | null) => {
    setPreview(role);
    try {
      if (role) sessionStorage.setItem(PREVIEW_ROLE, role);
      else sessionStorage.removeItem(PREVIEW_ROLE);
    } catch {
      // storage can be unavailable; the preview just does not persist
    }
  }, []);

  const setTheme = React.useCallback((t: ThemePref) => setLocalTheme(t), []);

  const value = React.useMemo<AuthValue | null>(() => {
    if (!me) return null;
    const actualRole = uiRole(me);
    const role = previewEnabled && preview ? preview : actualRole;
    return {
      me,
      role,
      actualRole,
      previewEnabled,
      setPreviewRole,
      theme,
      setTheme,
      can: (section) => canSee(section, role, me.capabilities),
    };
  }, [me, preview, previewEnabled, setPreviewRole, theme, setTheme]);

  if (meQuery.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas" aria-busy="true">
        <div className="flex w-72 flex-col gap-3" role="status" aria-label="Loading Bastion">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-52" />
        </div>
      </div>
    );
  }
  if (meQuery.isError || !value) {
    const unauthorized = (meQuery.error as { status?: number } | null)?.status === 401;
    // A 401 already triggered the redirect to /auth/login; show a calm holding screen meanwhile.
    return (
      <ProblemScreen
        error={meQuery.error}
        title={unauthorized ? 'Redirecting to sign in' : 'Bastion could not load your account'}
        onRetry={() => qc.invalidateQueries({ queryKey: ['me'] })}
        action={unauthorized ? { label: 'Sign in', href: '/auth/login' } : undefined}
      />
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = React.useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

export const useRole = (): UiRole => useAuth().role;
