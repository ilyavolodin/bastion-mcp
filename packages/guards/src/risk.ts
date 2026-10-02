import type { ItemRef, RiskState, RiskStore, Verdict } from './types';

/**
 * Session risk (13.7). A (principal, client) pair has a score that decays by half every 30 minutes.
 * `suspicious` findings add 1, `malicious` add 3. All maths are pure functions over a stored
 * (score, timestamp) pair; the `RiskStore` port only loads and saves it.
 */

export const RISK_HALF_LIFE_MS = 30 * 60 * 1000;
export const RISK_ESCALATION_THRESHOLD = 5;

export const RISK_WEIGHTS: Readonly<Record<Verdict, number>> = {
  clean: 0,
  suspicious: 1,
  malicious: 3,
};

/** The score at `now`, halved for every elapsed half-life. */
export const decayedScore = (state: RiskState | null, now: number): number => {
  if (state === null) return 0;
  const elapsed = Math.max(0, now - state.updatedAt);
  return state.score * 0.5 ** (elapsed / RISK_HALF_LIFE_MS);
};

export const addRisk = (state: RiskState | null, delta: number, now: number): RiskState => ({
  score: decayedScore(state, now) + delta,
  updatedAt: now,
});

export const riskDelta = (verdicts: Iterable<Verdict>): number => {
  let total = 0;
  for (const v of verdicts) total += RISK_WEIGHTS[v];
  return total;
};

export const shouldEscalate = (
  state: RiskState | null,
  now: number,
  threshold = RISK_ESCALATION_THRESHOLD,
): boolean => decayedScore(state, now) >= threshold;

/** Escalation applies to tools with `destructive: true` or `openWorld: true` (the "lethal trifecta"). */
export const isEscalationTarget = (item: ItemRef): boolean =>
  item.kind === 'tool' && (item.destructive === true || item.openWorld === true);

export const loadRisk = async (
  store: RiskStore,
  principalId: string,
  clientId: string,
): Promise<RiskState | null> => {
  try {
    return await store.get(principalId, clientId);
  } catch {
    return null;
  }
};

export const recordRisk = async (
  store: RiskStore,
  principalId: string,
  clientId: string,
  delta: number,
  now: number,
): Promise<RiskState | null> => {
  if (delta <= 0) return null;
  try {
    const next = addRisk(await store.get(principalId, clientId), delta, now);
    await store.set(principalId, clientId, next);
    return next;
  } catch {
    return null;
  }
};
