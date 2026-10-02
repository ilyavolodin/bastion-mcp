import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The MSW worker is a dev tool: keep it out of the production bundle that the server image serves. */
const dropMockWorker = (mode: string): Plugin => ({
  name: 'bastion:drop-mock-worker',
  apply: 'build',
  closeBundle() {
    if (mode !== 'mock') rmSync(here('./dist/mockServiceWorker.js'), { force: true });
  },
});

export const sharedAlias = {
  '@': here('./src'),
  // `@bastion-mcp/core` exposes one Node-only barrel (AEAD, net). The SPA only needs constants and
  // schemas, so it imports these two browser-safe modules directly.
  '@bastion-mcp/core/constants': here('../../packages/core/src/constants.ts'),
  '@bastion-mcp/core/org-settings': here('../../packages/core/src/org-settings.ts'),
  '@bastion-mcp/core/ids': here('../../packages/core/src/ids.ts'),
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.BASTION_URL ?? 'http://localhost:8080';
  return {
    plugins: [react(), tailwindcss(), dropMockWorker(mode)],
    resolve: { alias: sharedAlias },
    server: {
      port: 5173,
      proxy:
        mode === 'mock'
          ? undefined
          : {
              '/api': backend,
              '/auth': backend,
              '/oauth': backend,
              '/mcp': backend,
            },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('monaco-editor')) return 'monaco';
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor'))
              return 'charts';
            if (id.includes('@xyflow')) return 'flow';
            if (id.includes('node_modules')) return 'vendor';
            return undefined;
          },
        },
      },
    },
  };
});
