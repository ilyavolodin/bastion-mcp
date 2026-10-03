/** Time source port. Tests inject a fake; production uses `systemClock`. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Adapts a numeric clock to the `Date`-returning shape some ports use. */
export const dateClock = (clock: Clock): { now(): Date } => ({ now: () => new Date(clock.now()) });
