import { MS } from '@bastion-mcp/core';

/** Sandbox-package timeouts and delays, in milliseconds. */
export const SANDBOX_TIMEOUTS_MS = {
  /** Egress proxy: outbound connect (8.8). */
  egressConnect: 10_000,
  egressResolve: 5_000,
  egressIdle: 5 * MS.MINUTE,
  /** Runner HTTP/WebSocket calls. */
  runnerRequest: 15_000,
  /** bwrap: runner readiness. */
  bwrapReady: 30_000,
  /** bwrap: wait for the jail to exit before giving up on destroy. */
  bwrapExitGrace: 5_000,
  /** bwrap probe command. */
  probe: 10_000,
  /** Kubernetes: SandboxClaim binding and runner readiness. */
  claimBound: 2 * MS.MINUTE,
  runnerReady: MS.MINUTE,
} as const;
