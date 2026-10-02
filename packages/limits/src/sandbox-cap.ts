import { RateLimitedError } from '@bastion-mcp/core';

/** A sandbox instance as the instance manager sees it. */
export type SandboxInstanceInfo = {
  id: string;
  state: string;
  /** True when the instance has no in-flight calls and may be stopped (8.6). */
  idleEligible: boolean;
  lastUsedAt: Date | number;
};

export type SandboxStartPlan =
  | { action: 'start' }
  | { action: 'stop-then-start'; stopInstanceId: string }
  | { action: 'reject'; error: RateLimitedError };

const ms = (v: Date | number): number => (typeof v === 'number' ? v : v.getTime());

/**
 * Per-user running-sandbox cap (8.6, 14.3). With room, start. At the cap, stop the least recently used
 * idle-eligible instance to make room; with none eligible, reject with `-32011` (`RATE_LIMITED`).
 */
export const planSandboxStart = (
  instances: readonly SandboxInstanceInfo[],
  maxRunning: number,
): SandboxStartPlan => {
  const active = instances.filter((i) => i.state === 'running' || i.state === 'starting');
  if (active.length < maxRunning) return { action: 'start' };
  const victim = active
    .filter((i) => i.state === 'running' && i.idleEligible)
    .sort((a, b) => ms(a.lastUsedAt) - ms(b.lastUsedAt))[0];
  if (victim) return { action: 'stop-then-start', stopInstanceId: victim.id };
  return {
    action: 'reject',
    error: new RateLimitedError(
      `You already have ${maxRunning} running sandboxes and none is idle; try again shortly.`,
      { retryAfterMs: 5000, limit: 'running sandboxes per user' },
    ),
  };
};
