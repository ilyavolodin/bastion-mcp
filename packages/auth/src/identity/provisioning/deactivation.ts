/**
 * Deactivation (9.1): revoke all Bastion tokens and sessions, stop instances, delete upstream tokens
 * (RFC 7009 revocation where supported) and keep call-log and audit rows.
 */
export type DeactivationAction =
  | { type: 'mark_deactivated'; principalId: string }
  | { type: 'revoke_tokens'; principalId: string }
  | { type: 'destroy_sessions'; principalId: string }
  | { type: 'stop_instances'; principalId: string }
  | { type: 'delete_upstream_tokens'; principalId: string; revokeAtUpstream: true };

export type DeactivationPlan = {
  actions: DeactivationAction[];
  /** Records that are deliberately kept. */
  retained: ('call_log' | 'audit_log')[];
};

/** Steps that must succeed before the caller may report the principal as deactivated. */
const CRITICAL: ReadonlySet<DeactivationAction['type']> = new Set([
  'mark_deactivated',
  'revoke_tokens',
]);

export const planDeactivation = (input: { principalId: string }): DeactivationPlan => ({
  actions: [
    { type: 'mark_deactivated', principalId: input.principalId },
    { type: 'revoke_tokens', principalId: input.principalId },
    { type: 'destroy_sessions', principalId: input.principalId },
    { type: 'stop_instances', principalId: input.principalId },
    { type: 'delete_upstream_tokens', principalId: input.principalId, revokeAtUpstream: true },
  ],
  retained: ['call_log', 'audit_log'],
});

export interface DeactivationExecutor {
  execute(action: DeactivationAction): Promise<void>;
}

export type DeactivationResult = {
  completed: DeactivationAction['type'][];
  errors: { action: DeactivationAction['type']; message: string }[];
};

/**
 * Runs the actions in order. A failure in a critical step throws (the whole plan is idempotent and can
 * be retried); later cleanup steps are best-effort and their errors are returned.
 */
export const executeDeactivation = async (
  plan: DeactivationPlan,
  executor: DeactivationExecutor,
): Promise<DeactivationResult> => {
  const result: DeactivationResult = { completed: [], errors: [] };
  for (const action of plan.actions) {
    try {
      await executor.execute(action);
      result.completed.push(action.type);
    } catch (e) {
      if (CRITICAL.has(action.type)) throw e;
      result.errors.push({
        action: action.type,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
};
