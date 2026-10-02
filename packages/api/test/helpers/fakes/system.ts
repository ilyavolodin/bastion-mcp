import type { ApiDeps } from '../../../src/ports';
import type { FakeCtx } from '../harness';

export const fakeSystemDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  system: {
    status: async () => ({
      replicas: [{ id: 'r1', role: 'ui', startedAt: '2026-01-01T00:00:00.000Z', version: '1.0.0' }],
      leases: { active: 2 },
      queues: { jobs: { depth: 0 } },
      driver: { name: 'docker', healthy: true },
      registrySync: [],
      kms: { provider: 'local', healthy: true, kekRef: 'kek-1', lastRotatedAt: null },
      configVersion: 'cfg-1',
    }),
    rotateKms: async () => ({ kekRef: 'kek-2', rewrapped: 3 }),
    rotateSigningKeys: async () => ({ kids: ['kid-2'] }),
  },
});
