/** Enforces the package graph of docs/tdd.md section 5.3. A cycle or an upward import fails CI. */
const allowed = {
  core: [],
  db: ['core'],
  secrets: ['core'],
  telemetry: ['core'],
  policy: ['core', 'db', 'secrets', 'telemetry'],
  limits: ['core', 'db', 'secrets', 'telemetry'],
  guards: ['core', 'db', 'secrets', 'telemetry'],
  auth: ['core', 'db', 'secrets', 'telemetry'],
  overrides: ['core', 'db', 'secrets', 'telemetry'],
  router: ['core', 'overrides', 'policy', 'db', 'secrets', 'telemetry'],
  sandbox: ['core', 'telemetry', 'secrets'],
  'mcp-upstream': [
    'core',
    'sandbox',
    'auth',
    'router',
    'overrides',
    'policy',
    'secrets',
    'telemetry',
    'db',
  ],
  'mcp-downstream': [
    'core',
    'mcp-upstream',
    'guards',
    'limits',
    'router',
    'policy',
    'overrides',
    'auth',
    'telemetry',
    'db',
    'secrets',
  ],
  registry: ['core', 'db', 'secrets', 'telemetry'],
  plugins: ['core', 'db', 'secrets', 'telemetry'],
  api: [
    'core',
    'db',
    'policy',
    'auth',
    'registry',
    'secrets',
    'router',
    'plugins',
    'telemetry',
    'overrides',
    'guards',
    'limits',
  ],
  'api-client': [],
  testkit: ['core'],
};

const forbidden = Object.entries(allowed).map(([pkg, deps]) => {
  const ok = [pkg, ...deps].join('|');
  return {
    name: `package-graph-${pkg}`,
    comment: `@bastion-mcp/${pkg} may only depend on: ${deps.join(', ') || 'nothing internal'}`,
    severity: 'error',
    from: { path: `^packages/${pkg}/src` },
    to: { path: '^packages/([^/]+)/src', pathNot: `^packages/(${ok})/src` },
  };
});

module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    ...forbidden,
  ],
  options: { tsConfig: { fileName: 'tsconfig.base.json' }, doNotFollow: { path: 'node_modules' } },
};
