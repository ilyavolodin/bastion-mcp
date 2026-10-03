import type { InstallationView } from '@/api/views/servers';
import { DAY, HOUR, MINUTE, SECOND } from './time';

/** The locale every number and date of the console is formatted in. */
export const LOCALE = 'en-US';

export const initials = (name: string): string =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');

/** Two digits, zero padded. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const formatClock = (iso: string, seconds = false): string => {
  const d = new Date(iso);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return seconds ? `${base}:${pad2(d.getSeconds())}` : base;
};

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });

export const formatRelative = (iso: string, now: number = Date.now()): string => {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(diff / MINUTE);
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

const DAY_SECONDS = DAY / SECOND;
const HOUR_SECONDS = HOUR / SECOND;
const MINUTE_SECONDS = MINUTE / SECOND;

export const formatUptime = (sec: number): string => {
  if (sec >= DAY_SECONDS) return `${Math.floor(sec / DAY_SECONDS)} d`;
  if (sec >= HOUR_SECONDS) return `${Math.floor(sec / HOUR_SECONDS)} h`;
  return `${Math.max(1, Math.floor(sec / MINUTE_SECONDS))} min`;
};

/** Whole seconds from `startedAt` to `now` (epoch ms); never negative. */
export const secondsSince = (startedAt: string, now: number): number =>
  Math.max(0, (now - new Date(startedAt).getTime()) / SECOND);

/** True when `iso` is at most `windowMs` before `now` (epoch ms); false for no time at all. */
export const isWithin = (iso: string | null, windowMs: number, now: number): boolean =>
  iso !== null && new Date(iso).getTime() > now - windowMs;

export const formatNumber = (n: number): string => n.toLocaleString(LOCALE);

export const percent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.min(100, Math.max(0, (part / whole) * 100));

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
