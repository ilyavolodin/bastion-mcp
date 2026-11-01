/**
 * Long property runs. The nightly sets `FUZZ_RUNS` to 500,000, and one synchronous `fc.assert` of that size keeps the
 * Vitest worker from answering the runner for minutes: the test then "times out" after it finished, or the run dies
 * with `Timeout calling "onTaskUpdate"`. `inChunks` splits the runs and yields to the event loop between the chunks.
 *
 *   await inChunks(runs, (numRuns) => fc.assert(property, { numRuns }));
 *
 * This module has no imports, so a package can use it without pulling in the rest of the testkit (containers, servers).
 */

/** Runs per `fc.assert`; about a quarter of a second of work for the properties in this repository. */
export const FUZZ_CHUNK = 5_000;

/** The number of runs for a property: `FUZZ_RUNS` when set (the nightly), else the short default of a unit run. */
export const fuzzRuns = (
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number => {
  const configured = Number(env.FUZZ_RUNS);
  return env.FUZZ_RUNS !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : fallback;
};

/** Calls `run(n)` with chunks that add up to `total`, letting the event loop turn between them. */
export const inChunks = async (
  total: number,
  run: (runs: number) => void,
  chunk: number = FUZZ_CHUNK,
): Promise<void> => {
  for (let done = 0; done < total; done += chunk) {
    run(Math.min(chunk, total - done));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};
