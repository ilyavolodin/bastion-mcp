import { describe, expect, it } from 'vitest';
import { chooseTier, floorTo, rollupWindow } from '../src/repositories/telemetry';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-03-10T12:34:56Z');

describe('15.5 chooseTier', () => {
  it('uses minutes for a short recent range', () => {
    expect(chooseTier(at('2026-03-10T10:00:00Z'), NOW, NOW)).toBe('minute');
  });
  it('falls to hours when the range exceeds six hours', () => {
    expect(chooseTier(at('2026-03-10T05:00:00Z'), NOW, NOW)).toBe('hour');
  });
  it('falls to hours when the start is older than minute retention', () => {
    expect(chooseTier(at('2026-02-20T00:00:00Z'), at('2026-02-20T01:00:00Z'), NOW)).toBe('hour');
  });
  it('uses days for ranges over 60 days or older than hour retention', () => {
    expect(chooseTier(at('2026-01-01T00:00:00Z'), NOW, NOW)).toBe('day');
    expect(chooseTier(at('2025-10-01T00:00:00Z'), at('2025-10-02T00:00:00Z'), NOW)).toBe('day');
  });
});

describe('15.5 floorTo', () => {
  it('floors to the bucket boundary', () => {
    expect(floorTo(NOW, 60).toISOString()).toBe('2026-03-10T12:34:00.000Z');
    expect(floorTo(NOW, 3600).toISOString()).toBe('2026-03-10T12:00:00.000Z');
    expect(floorTo(NOW, 86_400).toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });
});

describe('15.5 rollupWindow', () => {
  it('starts lookback buckets before the watermark and ends at the last finished bucket', () => {
    const w = rollupWindow({
      tier: 'minute',
      now: NOW,
      lookback: 10,
      watermark: at('2026-03-10T12:30:00Z'),
      firstSource: null,
    });
    expect(w?.from.toISOString()).toBe('2026-03-10T12:20:00.000Z');
    expect(w?.to.toISOString()).toBe('2026-03-10T12:34:00.000Z');
  });

  it('starts at the first source row when nothing is rolled yet, and is empty without one', () => {
    const base = { tier: 'hour', now: NOW, lookback: 3, watermark: null } as const;
    expect(
      rollupWindow({ ...base, firstSource: at('2026-03-10T08:20:00Z') })?.from.toISOString(),
    ).toBe('2026-03-10T08:00:00.000Z');
    expect(rollupWindow({ ...base, firstSource: null })).toBeNull();
  });

  it('never catches up minutes further back than seven days', () => {
    const w = rollupWindow({
      tier: 'minute',
      now: NOW,
      lookback: 10,
      watermark: null,
      firstSource: at('2026-01-01T00:00:00Z'),
    });
    expect(w?.from.toISOString()).toBe('2026-03-03T12:34:00.000Z');
  });

  it('is empty when the window start is not before the last finished bucket', () => {
    expect(
      rollupWindow({
        tier: 'minute',
        now: NOW,
        lookback: 0,
        watermark: at('2026-03-10T12:34:00Z'),
        firstSource: null,
      }),
    ).toBeNull();
  });
});
