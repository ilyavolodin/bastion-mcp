import { defineConfig } from 'tsdown';

/**
 * Bundles apps/server into dist/main.js, dist/otel.js and dist/cli.js (ESM, node24), the contract of
 * deploy/docker/Dockerfile. Workspace packages (TypeScript sources, ADR 0001 item 3) and the generated Prisma
 * client are inlined; every other dependency stays external and is listed under "dependencies" in package.json,
 * so native modules (re2, @node-rs/argon2) and the OpenTelemetry instrumentations load from node_modules.
 */
export default defineConfig({
  entry: { main: 'src/main.ts', otel: 'src/otel.ts', cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  minify: false,
  shims: true,
  // fast-json-patch is CommonJS without ESM named exports; bundling it makes `import { applyPatch }` work.
  deps: { alwaysBundle: [/^@bastion-mcp\//, /^fast-json-patch/] },
  outExtensions: () => ({ js: '.js' }),
});
