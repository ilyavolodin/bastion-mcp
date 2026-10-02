import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig((env) =>
  mergeConfig(
    viteConfig(env),
    defineConfig({
      test: {
        name: 'web',
        environment: 'jsdom',
        globals: false,
        css: false,
        setupFiles: ['./src/test/polyfills.ts', './src/test/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}'],
        testTimeout: 15000,
        coverage: {
          provider: 'v8',
          include: ['src/**/*.{ts,tsx}'],
          exclude: [
            'src/**/*.test.{ts,tsx}',
            'src/components/ui/**',
            'src/test/**',
            'src/main.tsx',
            'src/mocks/browser.ts',
            'src/**/monaco-impl.tsx',
            'src/**/*.d.ts',
          ],
          thresholds: { lines: 70 },
        },
      },
    }),
  ),
);
