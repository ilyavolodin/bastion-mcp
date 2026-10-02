import { PolicyEngine } from '@bastion-mcp/policy';
import type { PolicyService } from '../contracts';
import type { Infra } from '../infra';
import { watchConfig } from './config-watch';

/**
 * The compiled Cedar engine for the current configuration (10, 4.3). `rebuild()` loads `PolicyDataSource` data from
 * the database and compiles; `watch()` rebuilds on every `bastion:config` event (single flight, the latest request
 * wins) so a policy edit takes effect on every worker within the event round trip.
 */
export const createPolicyService = (infra: Infra): PolicyService & { ready(): Promise<void> } => {
  let engine: PolicyEngine | undefined;
  let building: Promise<void> | undefined;
  let dirty = false;

  const options = {
    onDecision: () => undefined,
  };

  const build = async (): Promise<void> => {
    engine = await PolicyEngine.fromDataSource(infra.repos.policyData as never, options);
  };

  const rebuild = (): Promise<void> => {
    if (building) {
      dirty = true;
      return building;
    }
    building = (async () => {
      try {
        do {
          dirty = false;
          await build();
        } while (dirty);
      } finally {
        building = undefined;
      }
    })();
    return building;
  };

  return {
    current() {
      if (!engine) throw new Error('policy engine is not built yet');
      return engine;
    },
    async engine() {
      if (!engine) await rebuild();
      return engine as PolicyEngine;
    },
    data: infra.repos.policyData as never,
    rebuild,
    ready: rebuild,
    watch() {
      return watchConfig(infra, () => {
        rebuild().catch((error) =>
          infra.logger.error(
            { err: String(error) },
            'policy rebuild failed; keeping previous engine',
          ),
        );
      });
    },
  };
};
