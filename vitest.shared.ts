import { defineConfig } from 'vitest/config';

/** Shared Vitest settings; each package config merges this via `createVitestConfig`. */
export const createVitestConfig = (overrides: { name: string; coverageExclude?: string[] }) =>
  defineConfig({
    test: {
      name: overrides.name,
      include: ['test/**/*.test.ts'],
      environment: 'node',
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/index.ts', 'src/**/*.d.ts', ...(overrides.coverageExclude ?? [])],
        thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
      },
    },
  });
