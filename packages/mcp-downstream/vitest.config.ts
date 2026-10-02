import { mergeConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.shared';

export default mergeConfig(createVitestConfig({ name: 'mcp-downstream' }), {
  test: {
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 240_000,
  },
});
