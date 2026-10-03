import { type Clock, systemClock } from '@bastion-mcp/core';

export type PollOptions = {
  /** Total time to keep trying; the last value is returned once it has passed. */
  timeoutMs: number;
  /** Pause between attempts. */
  intervalMs: number;
  clock?: Clock;
  /** Replaces the real timer in tests. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until `isDone` accepts its value or `timeoutMs` has passed, pausing `intervalMs` between
 * attempts. Always makes at least one attempt and returns the last value, accepted or not; a throwing attempt
 * propagates.
 */
export const pollUntil = async <T>(
  attempt: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: PollOptions,
): Promise<T> => {
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? realSleep;
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const value = await attempt();
    if (isDone(value) || clock.now() >= deadline) return value;
    await sleep(options.intervalMs);
  }
};
