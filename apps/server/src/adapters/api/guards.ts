import type { ApiDeps } from '@bastion-mcp/api';
import type { GuardPhase } from '@bastion-mcp/guards';
import type { GuardService } from '../../contracts';
import type { Infra } from '../../infra';

/** API phase names (`tool_input` ...) map to the pipeline phases of 13.1. */
const PHASE: Record<'tool_input' | 'tool_output' | 'prompt' | 'resource', GuardPhase> = {
  tool_input: 'request',
  tool_output: 'response',
  prompt: 'response',
  resource: 'response',
};

const ITEM_KIND = {
  tool_input: 'tool',
  tool_output: 'tool',
  prompt: 'prompt',
  resource: 'resource',
} as const;

/**
 * `GuardTester` of the API (`POST /guard-profiles/{id}/test`, 13): runs the given profile on sample text through the
 * real pipeline, so the verdicts equal what a live call would get. Findings never include the text itself.
 */
export const createGuardApiPorts = (_infra: Infra, guards: GuardService): ApiDeps['guards'] => ({
  tester: {
    async test({ profile, text, phase, signal }) {
      const started = performance.now();
      const result = await guards.pipeline.run(
        {
          phase: PHASE[phase],
          segments: [{ path: phase === 'tool_input' ? 'arguments.text' : 'content[0].text', text }],
          principal: { principalId: 'guard-test' },
          installation: { installationId: 'guard-test' },
          item: { kind: ITEM_KIND[phase], name: 'guard-test' },
          method: phase === 'tool_input' ? 'tools/call' : 'tools/call',
        },
        { org: profile },
        signal ? { signal } : {},
      );
      return {
        blocked: result.action === 'block',
        findings: result.findings.map((f) => ({
          guard: f.guard,
          type: f.type,
          verdict: f.finding.verdict,
          action: f.action,
          ...(f.finding.reason ? { detail: f.finding.reason } : {}),
        })),
        durationMs: Math.round(performance.now() - started),
      };
    },
  },
});
