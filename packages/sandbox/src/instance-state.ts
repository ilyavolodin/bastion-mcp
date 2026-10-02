import { FAILURE_BACKOFF_MS } from '@bastion-mcp/core';

/**
 * Pure helpers for the instance manager built later in `mcp-upstream` (8.6):
 * absent -> starting{claiming,binding,installing,spawning,connecting} -> ready -> idle -> stopping -> absent,
 * with failed (backoff) -> absent.
 */

export const START_PHASES_ORDER = [
  'claiming',
  'binding',
  'installing',
  'spawning',
  'connecting',
] as const;
export type InstanceStartPhase = (typeof START_PHASES_ORDER)[number];

export type InstanceState =
  | { kind: 'absent' }
  | { kind: 'starting'; phase: InstanceStartPhase }
  | { kind: 'ready' }
  | { kind: 'idle' }
  | { kind: 'stopping' }
  | { kind: 'failed'; phase: InstanceStartPhase };

export type InstanceEvent =
  | { type: 'start' }
  | { type: 'phase'; phase: InstanceStartPhase }
  | { type: 'connected' }
  | { type: 'idleTimeout' }
  | { type: 'activity' }
  | { type: 'stop' }
  | { type: 'stopped' }
  | { type: 'fail' }
  /** The server process exited (runner `x` frame) while ready or idle. */
  | { type: 'crashed' }
  /** Backoff elapsed or the user clicked Restart. */
  | { type: 'reset' };

export type InstanceTransition =
  | { ok: true; state: InstanceState }
  | { ok: false; reason: string };

const no = (state: InstanceState, event: InstanceEvent): InstanceTransition => ({
  ok: false,
  reason: `event "${event.type}" is invalid in state "${state.kind}"`,
});

export const instanceStateMachine = (
  state: InstanceState,
  event: InstanceEvent,
): InstanceTransition => {
  switch (event.type) {
    case 'start':
      return state.kind === 'absent'
        ? { ok: true, state: { kind: 'starting', phase: 'claiming' } }
        : no(state, event);
    case 'phase': {
      if (state.kind !== 'starting') return no(state, event);
      const from = START_PHASES_ORDER.indexOf(state.phase);
      const to = START_PHASES_ORDER.indexOf(event.phase);
      return to > from
        ? { ok: true, state: { kind: 'starting', phase: event.phase } }
        : { ok: false, reason: `phase cannot go from ${state.phase} to ${event.phase}` };
    }
    case 'connected':
      return state.kind === 'starting' && state.phase === 'connecting'
        ? { ok: true, state: { kind: 'ready' } }
        : no(state, event);
    case 'idleTimeout':
      return state.kind === 'ready' ? { ok: true, state: { kind: 'idle' } } : no(state, event);
    case 'activity':
      return state.kind === 'idle' || state.kind === 'ready'
        ? { ok: true, state: { kind: 'ready' } }
        : no(state, event);
    case 'stop':
      return state.kind === 'ready' || state.kind === 'idle'
        ? { ok: true, state: { kind: 'stopping' } }
        : no(state, event);
    case 'stopped':
      return state.kind === 'stopping' ? { ok: true, state: { kind: 'absent' } } : no(state, event);
    case 'fail':
      return state.kind === 'starting'
        ? { ok: true, state: { kind: 'failed', phase: state.phase } }
        : no(state, event);
    case 'crashed':
      return state.kind === 'ready' || state.kind === 'idle'
        ? { ok: true, state: { kind: 'absent' } }
        : no(state, event);
    case 'reset':
      return state.kind === 'failed' ? { ok: true, state: { kind: 'absent' } } : no(state, event);
  }
};

// --- failure backoff (8.6) --------------------------------------------------------------------------------------
export const FAILURE_WINDOW_MS = 30 * 60 * 1000;
export const ERROR_FAILURE_THRESHOLD = 3;
export const EARLY_EXIT_WINDOW_MS = 30 * 1000;

/** Failure timestamps (ms). Keep only the entries inside the window, newest last. */
export type FailureHistory = readonly number[];

export const recordFailure = (history: FailureHistory, now: number): FailureHistory => [
  ...history.filter((t) => now - t < FAILURE_WINDOW_MS),
  now,
];

const recent = (history: FailureHistory, now: number): number[] =>
  history.filter((t) => now - t < FAILURE_WINDOW_MS);

/** Wait before the next start attempt after `failures` consecutive failures: 5 s, 30 s, 2 min, 10 min. */
export const backoffMs = (failures: number): number => {
  if (failures <= 0) return 0;
  return FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1] as number;
};

/** Three failures within 30 minutes mark the installation `error` (8.6). */
export const isInstallationError = (history: FailureHistory, now: number): boolean =>
  recent(history, now).length >= ERROR_FAILURE_THRESHOLD;

export type RetryDecision = { allowed: true } | { allowed: false; retryInMs: number };

/** Calls fail fast (`-32016`) until the backoff passes or the user restarts (8.6). */
export const retryDecision = (history: FailureHistory, now: number): RetryDecision => {
  const failures = recent(history, now);
  const last = failures.at(-1);
  if (last === undefined) return { allowed: true };
  const wait = backoffMs(failures.length) - (now - last);
  return wait <= 0 ? { allowed: true } : { allowed: false, retryInMs: wait };
};

/** A crash within 30 s of start counts as a failure (8.6). */
export const crashCountsAsFailure = (startedAt: number, exitedAt: number): boolean =>
  exitedAt - startedAt < EARLY_EXIT_WINDOW_MS;

// --- LRU eviction -------------------------------------------------------------------------------------------------
export type InstanceSummary = {
  id: string;
  userId: string | null;
  state: InstanceState['kind'];
  lastUsedAt: number;
  inflight: number;
};

/**
 * The least recently used idle-eligible instance of the user (ready or idle with no in-flight calls), stopped
 * to make room under `BASTION_MAX_RUNNING_INSTANCES_PER_USER` (8.6). Undefined means the start fails (-32011).
 */
export const pickLruIdleInstance = (
  instances: readonly InstanceSummary[],
  userId: string,
): InstanceSummary | undefined => {
  let best: InstanceSummary | undefined;
  for (const instance of instances) {
    if (instance.userId !== userId) continue;
    if (instance.state !== 'idle' && instance.state !== 'ready') continue;
    if (instance.inflight > 0) continue;
    if (!best || instance.lastUsedAt < best.lastUsedAt) best = instance;
  }
  return best;
};
