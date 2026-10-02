import type { QuotaPeriod } from './rules';

/**
 * Quota periods in the org time zone (14.2, 19.2). Pure functions of an instant and an IANA zone;
 * DST-safe because period boundaries are found by searching for the first instant whose local calendar
 * date reaches the boundary date, not by adding fixed offsets.
 */

type YMD = { y: number; m: number; d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
};

/** Local calendar date of an instant in a time zone. */
const localDate = (instantMs: number, timeZone: string): YMD => {
  const out: YMD = { y: 0, m: 0, d: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type === 'year') out.y = Number(part.value);
    else if (part.type === 'month') out.m = Number(part.value);
    else if (part.type === 'day') out.d = Number(part.value);
  }
  return out;
};

const ordinal = (v: YMD): number => v.y * 10_000 + v.m * 100 + v.d;

/** Normalises a possibly overflowing year/month/day through UTC arithmetic. */
const normalise = (y: number, m: number, d: number): YMD => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};

/** Earliest instant (second resolution) at which the local date in `timeZone` is at least `target`. */
const startOfLocalDate = (target: YMD, timeZone: string): number => {
  const guess = Date.UTC(target.y, target.m - 1, target.d);
  // Zone offsets are within +-14h and DST shifts are at most a few hours.
  let lo = Math.floor((guess - 36 * 3_600_000) / 1000);
  let hi = Math.floor((guess + 36 * 3_600_000) / 1000);
  const goal = ordinal(target);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ordinal(localDate(mid * 1000, timeZone)) >= goal) hi = mid;
    else lo = mid + 1;
  }
  return lo * 1000;
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** ISO 8601 week number and week-year for a local date. */
const isoWeek = (v: YMD): { year: number; week: number } => {
  const date = new Date(Date.UTC(v.y, v.m - 1, v.d));
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // the Thursday of this week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return {
    year: date.getUTCFullYear(),
    week: Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7),
  };
};

/** The period label used inside quota keys: `2026-10`, `2026-10-01`, `2026-W40`. */
export const quotaPeriodKey = (period: QuotaPeriod, now: Date, timeZone: string): string => {
  const local = localDate(now.getTime(), timeZone);
  switch (period) {
    case 'day':
      return `${pad(local.y, 4)}-${pad(local.m)}-${pad(local.d)}`;
    case 'month':
      return `${pad(local.y, 4)}-${pad(local.m)}`;
    case 'week': {
      const { year, week } = isoWeek(local);
      return `${pad(year, 4)}-W${pad(week)}`;
    }
  }
};

/** First instant of the next period (ISO weeks start on Monday). */
export const periodEnd = (period: QuotaPeriod, now: Date, timeZone: string): Date => {
  const local = localDate(now.getTime(), timeZone);
  let next: YMD;
  switch (period) {
    case 'day':
      next = normalise(local.y, local.m, local.d + 1);
      break;
    case 'month':
      next = normalise(local.y, local.m + 1, 1);
      break;
    case 'week': {
      const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
      const sinceMonday = (dow + 6) % 7;
      next = normalise(local.y, local.m, local.d - sinceMonday + 7);
      break;
    }
  }
  return new Date(startOfLocalDate(next, timeZone));
};

/** Whole seconds (rounded up) from `now` to the end of the current period. */
export const secondsToPeriodEnd = (period: QuotaPeriod, now: Date, timeZone: string): number =>
  Math.max(1, Math.ceil((periodEnd(period, now, timeZone).getTime() - now.getTime()) / 1000));

const ONE_DAY_SECONDS = 86_400;

export type PeriodWindow = {
  /** Period label inside the Redis key. */
  key: string;
  resetsAt: Date;
  secondsToEnd: number;
  /** Redis TTL: seconds to the period end plus one day (14.2). */
  durationSeconds: number;
};

export const periodWindow = (period: QuotaPeriod, now: Date, timeZone: string): PeriodWindow => {
  const resetsAt = periodEnd(period, now, timeZone);
  const secondsToEnd = secondsToPeriodEnd(period, now, timeZone);
  return {
    key: quotaPeriodKey(period, now, timeZone),
    resetsAt,
    secondsToEnd,
    durationSeconds: secondsToEnd + ONE_DAY_SECONDS,
  };
};
