import { defineConfig } from 'vitest/config';

/** Runs `test/e2e-real/serve.e2e.ts`: the long-lived stack under the browser specs of `apps/web/e2e/real`. */
export default defineConfig({
  test: {
    name: 'server-e2e-real',
    include: ['test/e2e-real/serve.e2e.ts'],
    environment: 'node',
    testTimeout: 0,
    hookTimeout: 0,
    pool: 'forks',
  },
});
