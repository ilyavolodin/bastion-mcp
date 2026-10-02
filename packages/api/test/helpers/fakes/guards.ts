import type { ApiDeps } from '../../../src/ports';
import type { FakeCtx } from '../harness';

/** Flags the sample text as malicious when it contains `ignore previous instructions`. */
export const fakeGuardsDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  guards: {
    tester: {
      async test(input) {
        const bad = /ignore previous instructions/i.test(input.text);
        return {
          blocked: bad,
          durationMs: 3,
          findings: input.profile.guards.map((g) => ({
            guard: g.instanceId,
            type: g.type,
            verdict: bad ? ('malicious' as const) : ('clean' as const),
            action: bad ? 'block' : 'allow',
          })),
        };
      },
    },
  },
});
