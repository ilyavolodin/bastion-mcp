import type { GuardProfile } from '@bastion-mcp/guards';

export type GuardTestFinding = {
  guard: string;
  type: string;
  verdict: 'clean' | 'suspicious' | 'malicious';
  action: string;
  detail?: string;
};

/** Runs a profile against sample text (`POST /guard-profiles/{id}/test`, 13). */
export interface GuardTester {
  test(input: {
    profile: GuardProfile;
    text: string;
    phase: 'tool_input' | 'tool_output' | 'prompt' | 'resource';
    signal?: AbortSignal;
  }): Promise<{ blocked: boolean; findings: GuardTestFinding[]; durationMs: number }>;
}
