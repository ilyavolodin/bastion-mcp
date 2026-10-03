import { createVitestConfig } from '../../vitest.shared';

export default createVitestConfig({
  name: 'testkit',
  // The fake servers and container helpers are test support code that other packages' suites exercise; only the
  // small pure helpers (http, net) are measured here.
  coverageExclude: ['src/fake-upstreams/**', 'src/containers.ts'],
});
