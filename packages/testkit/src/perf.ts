/**
 * Time limits for tests. A test states the budget it expects on a developer machine, and `budget()` multiplies it by a
 * factor for the machine the suite really runs on, so a shared CI runner does not need every test loosened by hand.
 *
 *   expect(p99).toBeLessThan(budget(15));
 *
 * The factor is, in order: `BASTION_PERF_FACTOR` when it is set (a number >= 1; use it to tune one runner), else
 * `CI_PERF_FACTOR` when the `CI` variable is set (GitHub's shared runners measured 2 to 4.5 times slower than the quiet
 * machine the budgets are written for), else 1.
 *
 * This module has no imports, so a package can use it without pulling in the rest of the testkit (containers, servers).
 */

/** Slowdown assumed for a CI runner when `BASTION_PERF_FACTOR` is not set. */
export const CI_PERF_FACTOR = 4;

export const perfFactor = (env: Record<string, string | undefined> = process.env): number => {
  const explicit = Number(env.BASTION_PERF_FACTOR);
  if (env.BASTION_PERF_FACTOR !== undefined && Number.isFinite(explicit) && explicit >= 1) {
    return explicit;
  }
  return env.CI ? CI_PERF_FACTOR : 1;
};

/** `ms` as written for a developer machine, scaled for this one. */
export const budget = (ms: number, env: Record<string, string | undefined> = process.env): number =>
  ms * perfFactor(env);
