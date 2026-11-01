import { defineConfig } from 'vitest/config';
import { fuzzRuns } from './packages/testkit/src/fuzz';
import { perfFactor } from './packages/testkit/src/perf';

/** Shared Vitest settings; each package config merges this via `createVitestConfig`. */
export const createVitestConfig = (overrides: { name: string; coverageExclude?: string[] }) =>
  defineConfig({
    test: {
      name: overrides.name,
      include: ['test/**/*.test.ts'],
      environment: 'node',
      // Generous ceiling: suites run in parallel under v8 coverage, which slows property tests several times over. It
      // scales with the machine like the timing budgets do (`budget()` in @bastion-mcp/testkit/perf),
      // and a fuzz run (`FUZZ_RUNS`) gets at least a millisecond per run: the nightly's 500,000 runs outlast 120 s on CI.
      testTimeout: Math.max(30_000 * perfFactor(), fuzzRuns(0)),
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/index.ts', 'src/**/*.d.ts', ...(overrides.coverageExclude ?? [])],
        thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
      },
    },
  });
