import { defineConfig } from '@playwright/test';

/**
 * Browser specs against the REAL server (no MSW): `apps/server/test/e2e-real` boots Bastion in-process on Testcontainers
 * Postgres and Redis with the built SPA (`pnpm build` first). `E2E_PORT` (default 18080) is the app, +1 the control API.
 */
const port = Number(process.env.E2E_PORT ?? 18080);

export default defineConfig({
  testDir: './e2e/real',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'pnpm --filter @bastion-mcp/server exec vitest run -c vitest.e2e-real.config.ts',
    url: `http://localhost:${port + 1}/state`,
    reuseExistingServer: true,
    timeout: 300_000,
    env: { E2E_PORT: String(port) },
  },
});
