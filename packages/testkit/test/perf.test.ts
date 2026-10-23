import { describe, expect, it } from 'vitest';
import { budget, CI_PERF_FACTOR, perfFactor } from '../src/perf';

describe('perf budgets', () => {
  it('is 1 on a developer machine and the CI factor on a CI runner', () => {
    expect(perfFactor({})).toBe(1);
    expect(perfFactor({ CI: 'true' })).toBe(CI_PERF_FACTOR);
    expect(budget(15, { env: { CI: 'true' } })).toBe(15 * CI_PERF_FACTOR);
    expect(budget(15, { env: {} })).toBe(15);
  });

  it('BASTION_PERF_FACTOR overrides both, and a value below 1 or not a number is ignored', () => {
    expect(perfFactor({ BASTION_PERF_FACTOR: '10' })).toBe(10);
    expect(perfFactor({ CI: 'true', BASTION_PERF_FACTOR: '1.5' })).toBe(1.5);
    expect(perfFactor({ CI: 'true', BASTION_PERF_FACTOR: '0.1' })).toBe(CI_PERF_FACTOR);
    expect(perfFactor({ BASTION_PERF_FACTOR: 'fast' })).toBe(1);
  });

  it('a test can set its own CI factor; it changes nothing off CI and the override still wins', () => {
    expect(budget(5, { ci: 12, env: { CI: 'true' } })).toBe(60);
    expect(budget(5, { ci: 12, env: {} })).toBe(5);
    expect(budget(5, { ci: 12, env: { CI: 'true', BASTION_PERF_FACTOR: '2' } })).toBe(10);
  });
});
