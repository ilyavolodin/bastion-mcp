import { describe, expect, it } from 'vitest';
import { AVATAR_COLORS, avatarColor, hashString, TINTS, tintOf } from './avatar';
import {
  formatNumber,
  formatRelative,
  formatUptime,
  isWithin,
  LOCALE,
  pad2,
  secondsSince,
} from './format';
import { DAY, HOUR, MINUTE, SECOND, WEEK_MS } from './time';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('time units', () => {
  it('are consistent with one another', () => {
    expect(SECOND).toBe(1000);
    expect(MINUTE).toBe(60 * SECOND);
    expect(HOUR).toBe(60 * MINUTE);
    expect(DAY).toBe(24 * HOUR);
    expect(WEEK_MS).toBe(7 * DAY);
  });
});

describe('pure time helpers', () => {
  it('pad2 pads to two digits', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(7)).toBe('07');
    expect(pad2(23)).toBe('23');
  });

  it('secondsSince counts from a start to a given now and never goes negative', () => {
    expect(secondsSince(ago(90 * SECOND), NOW)).toBe(90);
    expect(secondsSince(ago(-5 * SECOND), NOW)).toBe(0);
  });

  it('isWithin is true for a time inside the window before now, false outside it or for none', () => {
    expect(isWithin(ago(DAY), WEEK_MS, NOW)).toBe(true);
    expect(isWithin(ago(WEEK_MS - 1), WEEK_MS, NOW)).toBe(true);
    expect(isWithin(ago(WEEK_MS), WEEK_MS, NOW)).toBe(false);
    expect(isWithin(ago(8 * DAY), WEEK_MS, NOW)).toBe(false);
    expect(isWithin(null, WEEK_MS, NOW)).toBe(false);
  });

  it('isWithin and formatRelative follow the now they are given, not the clock', () => {
    const iso = ago(3 * HOUR);
    expect(formatRelative(iso, NOW)).toBe('3 h ago');
    expect(formatRelative(iso, NOW + DAY)).toBe('yesterday');
    expect(isWithin(iso, HOUR, NOW + HOUR * 4)).toBe(false);
  });

  it('formatUptime chooses days, hours or minutes', () => {
    expect(formatUptime(3 * 86_400 + 5)).toBe('3 d');
    expect(formatUptime(2 * 3600 + 59)).toBe('2 h');
    expect(formatUptime(125)).toBe('2 min');
    expect(formatUptime(5)).toBe('1 min');
  });

  it('formats numbers in the console locale', () => {
    expect(LOCALE).toBe('en-US');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('avatar colours', () => {
  it('hashString is stable and non-negative', () => {
    expect(hashString('github')).toBe(hashString('github'));
    expect(hashString('')).toBe(0);
    expect(
      hashString('a very long name that overflows 32 bits many times over'),
    ).toBeGreaterThanOrEqual(0);
  });

  it('avatarColor and tintOf pick from their own palettes by the same hash', () => {
    for (const seed of ['Ana', 'u-1', 'Platform team', '']) {
      expect(AVATAR_COLORS).toContain(avatarColor(seed));
      expect(avatarColor(seed)).toBe(avatarColor(seed));
      expect(TINTS).toContain(tintOf(seed));
    }
    expect(avatarColor('a')).toBe(AVATAR_COLORS[hashString('a') % AVATAR_COLORS.length]);
  });
});
