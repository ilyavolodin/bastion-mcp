import { defineConfig } from 'vitest/config';

// Standalone config: this directory is not a pnpm workspace member (see package.json).
export default defineConfig({
  test: { name: 'load', include: ['test/**/*.test.ts'], environment: 'node' },
});
