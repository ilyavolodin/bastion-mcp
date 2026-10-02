import type { ApiDeps } from '../../../src/ports';
import type { FakeCtx } from '../harness';

/** Reports `consumed = 7` against every rule's limit. */
export const fakeLimitsDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  limits: {
    async readUsage(rule, subjectId) {
      const limit = rule.kind === 'concurrency' ? rule.params.max : rule.params.points;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        subjectId,
        limit,
        consumed: 7,
        remaining: Math.max(limit - 7, 0),
        resetsAt: rule.kind === 'concurrency' ? null : '2026-06-02T00:00:00.000Z',
      };
    },
  },
});
