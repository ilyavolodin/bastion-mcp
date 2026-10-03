import { describe, expect, it } from 'vitest';
import { compareVersions, rollingOutReplicas } from './settings';

describe('compareVersions (15.7)', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('treats a missing part as 0 and equal versions as equal', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  it('counts a part that is not a number as 0', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
    expect(compareVersions('abc', '0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.beta')).toBeGreaterThan(0);
  });

  it('sorts a list of versions oldest first', () => {
    expect(['1.10.0', '1.2.0', '1.9.1', '0.9'].sort(compareVersions)).toEqual([
      '0.9',
      '1.2.0',
      '1.9.1',
      '1.10.0',
    ]);
  });
});

describe('rollingOutReplicas (15.7)', () => {
  const replicas = (versions: string[]) =>
    versions.map((version, i) => ({ id: `r${i}`, role: 'worker', version, startedAt: '' }));

  it('is empty when every replica runs one version', () => {
    expect(rollingOutReplicas(replicas(['1.0.0', '1.0.0']) as never).size).toBe(0);
  });

  it('marks the replicas on the newest version when versions differ, by number', () => {
    const rolling = rollingOutReplicas(replicas(['1.9.0', '1.10.0', '1.10.0']) as never);
    expect([...rolling].sort()).toEqual(['r1', 'r2']);
  });
});
