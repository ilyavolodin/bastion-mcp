import { defineConfig, mergeConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.shared';

// Git subprocess tests are slow when the whole workspace runs in parallel.
export default mergeConfig(
  createVitestConfig({ name: 'plugins' }),
  defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } }),
);
