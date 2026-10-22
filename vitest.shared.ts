import { defineConfig } from 'vitest/config';

/** Shared Vitest settings; each package config merges this via `createVitestConfig`. */
export const createVitestConfig = (overrides: { name: string; coverageExclude?: string[] }) =>
  defineConfig({
    test: {
      name: overrides.name,
      include: ['test/**/*.test.ts'],
      environment: 'node',
      // Generous ceiling: suites run in parallel under v8 coverage, which slows property tests several times over.
      testTimeout: 30_000,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/index.ts', 'src/**/*.d.ts', ...(overrides.coverageExclude ?? [])],
        thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
      },
    },
  });
