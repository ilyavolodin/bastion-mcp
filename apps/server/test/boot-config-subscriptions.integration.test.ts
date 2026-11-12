import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { bootStack, type Stack } from './helpers/stack';

const calls = vi.hoisted(() => ({ policyBuilds: 0, policyWatches: 0, limitWatches: 0 }));

vi.mock('../src/adapters/policy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/adapters/policy')>();
  return {
    ...original,
    createPolicyService: (...args: Parameters<typeof original.createPolicyService>) => {
      const service = original.createPolicyService(...args);
      return {
        ...service,
        rebuild: () => {
          calls.policyBuilds += 1;
          return service.rebuild();
        },
        ready: () => {
          calls.policyBuilds += 1;
          return service.ready();
        },
        watch: () => {
          calls.policyWatches += 1;
          return service.watch();
        },
      };
    },
  };
});

vi.mock('../src/adapters/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/adapters/limits')>();
  return {
    ...original,
    createLimitService: (...args: Parameters<typeof original.createLimitService>) => {
      const service = original.createLimitService(...args);
      return {
        ...service,
        watch: () => {
          calls.limitWatches += 1;
          return service.watch();
        },
      };
    },
  };
});

describe.skipIf(!haveDocker())(
  '4.3 boot subscribes policy and limits to bastion:config once',
  () => {
    let env: TestEnv;
    let stack: Stack | undefined;

    beforeAll(async () => {
      env = await createTestEnv();
    });
    beforeEach(async () => {
      await stack?.stop();
      stack = undefined;
      calls.policyBuilds = 0;
      calls.policyWatches = 0;
      calls.limitWatches = 0;
    });
    afterAll(async () => {
      await stack?.stop();
      await env?.cleanup();
    });

    it('4.3 a process hosting the worker (all) compiles the policy engine once and watches policy and limits once', async () => {
      stack = await bootStack({ env, role: 'all' });
      expect(calls).toEqual({ policyBuilds: 1, policyWatches: 1, limitWatches: 1 });
    });

    it('4.3 a worker-only process does the same', async () => {
      stack = await bootStack({ env, role: 'worker' });
      expect(calls).toEqual({ policyBuilds: 1, policyWatches: 1, limitWatches: 1 });
    });

    it('4.3 a ui-only process compiles and watches once too', async () => {
      stack = await bootStack({ env, role: 'ui' });
      expect(calls).toEqual({ policyBuilds: 1, policyWatches: 1, limitWatches: 1 });
    });
  },
);
