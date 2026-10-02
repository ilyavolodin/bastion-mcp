import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { periodEnd, periodWindow, quotaPeriodKey, secondsToPeriodEnd } from '../src';

const at = (iso: string) => new Date(iso);

describe('14.2 quota period keys', () => {
  it('14.2 encodes day, week and month labels in the org time zone', () => {
    const now = at('2026-10-01T03:00:00Z'); // 23:00 on 30 Sep in New York
    expect(quotaPeriodKey('month', now, 'UTC')).toBe('2026-10');
    expect(quotaPeriodKey('month', now, 'America/New_York')).toBe('2026-09');
    expect(quotaPeriodKey('day', now, 'America/New_York')).toBe('2026-09-30');
    expect(quotaPeriodKey('day', now, 'Asia/Tokyo')).toBe('2026-10-01');
    expect(quotaPeriodKey('week', now, 'UTC')).toBe('2026-W40');
  });

  it('14.2 uses ISO weeks across the year boundary', () => {
    expect(quotaPeriodKey('week', at('2027-01-01T12:00:00Z'), 'UTC')).toBe('2026-W53');
    expect(quotaPeriodKey('week', at('2025-12-29T00:00:00Z'), 'UTC')).toBe('2026-W01');
  });

  it('14.2 resets exactly at the period boundary in the org time zone', () => {
    // Day boundary in New York is 04:00Z while EDT applies.
    expect(periodEnd('day', at('2026-10-01T03:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-10-01T04:00:00.000Z',
    );
    expect(secondsToPeriodEnd('day', at('2026-10-01T03:00:00Z'), 'America/New_York')).toBe(3600);
    expect(periodEnd('week', at('2026-10-01T10:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(periodEnd('month', at('2026-12-31T23:59:59Z'), 'UTC').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('14.2 is DST-safe: a 25-hour day and a month spanning a DST change', () => {
    // US fall back on 1 Nov 2026: that local day lasts 25 hours.
    const start = at('2026-11-01T04:00:00Z');
    const end = periodEnd('day', at('2026-11-01T12:00:00Z'), 'America/New_York');
    expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
    // October in Berlin ends at 23:00Z on the 31st (CET after the 25 Oct change).
    expect(periodEnd('month', at('2026-10-10T00:00:00Z'), 'Europe/Berlin').toISOString()).toBe(
      '2026-10-31T23:00:00.000Z',
    );
  });

  it('14.2 duration is seconds to the period end plus one day', () => {
    const w = periodWindow('day', at('2026-10-01T03:00:00Z'), 'America/New_York');
    expect(w.key).toBe('2026-09-30');
    expect(w.secondsToEnd).toBe(3600);
    expect(w.durationSeconds).toBe(3600 + 86_400);
    expect(w.resetsAt.toISOString()).toBe('2026-10-01T04:00:00.000Z');
  });
});

const zones = [
  'UTC',
  'America/New_York',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'America/Havana',
  'Pacific/Auckland',
  'America/St_Johns',
];
const instants = fc.integer({
  min: Date.UTC(2024, 0, 1),
  max: Date.UTC(2031, 0, 1),
});

describe('14.2 period math properties', () => {
  for (const period of ['day', 'week', 'month'] as const) {
    it(`14.2 ${period}: key is stable until the end and changes exactly at it, in every zone`, () => {
      fc.assert(
        fc.property(instants, fc.constantFrom(...zones), (ms, zone) => {
          const now = new Date(ms);
          const end = periodEnd(period, now, zone);
          const key = quotaPeriodKey(period, now, zone);
          const maxSpan = period === 'month' ? 32 : period === 'week' ? 7 : 1;
          expect(end.getTime()).toBeGreaterThan(now.getTime());
          expect(end.getTime() - now.getTime()).toBeLessThanOrEqual(
            maxSpan * 86_400_000 + 3_600_000 * 2,
          );
          expect(quotaPeriodKey(period, new Date(end.getTime() - 1000), zone)).toBe(key);
          expect(quotaPeriodKey(period, end, zone)).not.toBe(key);
          expect(secondsToPeriodEnd(period, now, zone)).toBeGreaterThanOrEqual(1);
        }),
        { numRuns: 300 },
      );
    });
  }

  it('14.2 month boundaries: the key advances through every month of a year', () => {
    let now = at('2026-01-15T12:00:00Z');
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) {
      keys.push(quotaPeriodKey('month', now, 'America/New_York'));
      now = periodEnd('month', now, 'America/New_York');
    }
    expect(keys).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
    );
  });
});
