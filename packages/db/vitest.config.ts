import { mergeConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.shared';

export default mergeConfig(createVitestConfig({ name: 'db' }), {
  test: {
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 240_000,
    coverage: { exclude: ['src/generated/**', 'src/**/index.ts', 'src/**/*.d.ts'] },
  },
});
