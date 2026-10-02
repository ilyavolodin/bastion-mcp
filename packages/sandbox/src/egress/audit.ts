import type { DenyReason, EgressProtocol } from './policy';

/** Audit of every proxied connection (8.8): host, port, resolved IP, decision, bytes each way, duration. */
export type EgressAuditEvent = {
  instanceId: string;
  protocol: EgressProtocol;
  host: string;
  port: number;
  resolvedIp: string | null;
  decision: 'allow' | 'deny';
  reason?: DenyReason | 'allowlist' | 'mirror' | 'cidr';
  bytesUp: number;
  bytesDown: number;
  durationMs: number;
  ts: number;
};

/** Implemented by `apps/server` (`egress_events` table; the installation page shows denials). */
export interface EgressAuditSink {
  record(event: EgressAuditEvent): void | Promise<void>;
}

export const DEFAULT_ALLOWED_SAMPLE_RATE = 0.1;

/** 100% of denials, `allowedRate` (default 10%) of allowed connections (8.8). */
export const shouldAudit = (
  decision: 'allow' | 'deny',
  options: { allowedRate?: number; random?: () => number } = {},
): boolean => {
  if (decision === 'deny') return true;
  const rate = options.allowedRate ?? DEFAULT_ALLOWED_SAMPLE_RATE;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return (options.random ?? Math.random)() < rate;
};
