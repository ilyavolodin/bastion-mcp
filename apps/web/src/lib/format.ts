import type { InstallationView } from '@/api/views/servers';

export const initials = (name: string): string =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');

const pad = (n: number) => String(n).padStart(2, '0');

export const formatClock = (iso: string, seconds = false): string => {
  const d = new Date(iso);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return seconds ? `${base}:${pad(d.getSeconds())}` : base;
};

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const formatRelative = (iso: string, now: number = Date.now()): string => {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
};

export const formatUptime = (sec: number): string => {
  if (sec >= 86_400) return `${Math.floor(sec / 86_400)} d`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} h`;
  return `${Math.max(1, Math.floor(sec / 60))} min`;
};

export const formatNumber = (n: number): string => n.toLocaleString('en-US');

export const percent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.min(100, Math.max(0, (part / whole) * 100));

export const PALETTE = [
  'var(--tangerine)',
  'var(--sky)',
  'var(--teal)',
  'var(--berry)',
  'var(--mint)',
  'var(--sun)',
] as const;

/** A stable avatar colour for an id or name. */
export const avatarColor = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? PALETTE[0];
};

export type InstallationAction = {
  label: string;
  kind: 'connect' | 'secret' | 'reconnect' | 'why';
};

/** The one next action for an installation that is not ready (18.1 "one next action per state"). */
export function installationAction(
  i: Pick<InstallationView, 'status' | 'authMode' | 'displayName'>,
): InstallationAction | null {
  switch (i.status) {
    case 'needs_setup':
      return i.authMode === 'oauth'
        ? { label: `Connect ${i.displayName}`, kind: 'connect' }
        : { label: 'Add API key', kind: 'secret' };
    case 'reconnect_required':
      return { label: `Reconnect ${i.displayName}`, kind: 'reconnect' };
    case 'error':
      return { label: 'See why', kind: 'why' };
    default:
      return null;
  }
}

export const RUNTIME_LABEL = {
  remote: 'Remote',
  npm: 'npm',
  pypi: 'Python',
  python: 'Python',
  oci: 'Container',
} as const;

export const AUTH_LABEL = {
  oauth: 'Connect with OAuth',
  userSecret: 'Needs your API key',
  teamSecret: 'Ready to use',
  orgSecret: 'Ready to use',
  enterpriseManaged: 'Uses your company sign-in',
  tokenExchange: 'Uses your company sign-in',
  none: 'Ready to use',
} as const;

export const ISOLATION_LABEL = {
  none: 'No isolation',
  namespaces: 'Namespaces',
  gvisor: 'gVisor',
} as const;
