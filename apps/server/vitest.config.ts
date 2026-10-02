import { mergeConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.shared';

export default mergeConfig(createVitestConfig({ name: 'server' }), {
  test: {
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    globalSetup: ['test/helpers/global-setup.ts'],
    coverage: { exclude: ['src/**/index.ts', 'src/**/*.d.ts'] },
  },
});
