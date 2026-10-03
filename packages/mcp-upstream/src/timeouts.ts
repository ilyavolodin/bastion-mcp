import { MS } from '@bastion-mcp/core';

/** Time limits of the upstream layer, in one place so no call site carries a bare number. */
export const UPSTREAM_TIMEOUTS_MS = {
  /** Handshake with a streamable-HTTP or SSE remote; the transport has its own request timeouts. */
  remoteConnect: 15 * MS.SECOND,
  /** Handshake with a sandboxed stdio server. */
  sandboxConnect: 30 * MS.SECOND,
  /** TCP/TLS connect of the per-installation undici agents (8.9). */
  agentConnect: 30 * MS.SECOND,
  agentKeepAlive: 30 * MS.SECOND,
  /** Liveness ping when a stored legacy remote session is resumed (21.2). */
  resumePing: 10 * MS.SECOND,
  /** A subscription or listen request to an upstream. */
  subscriptionRequest: 30 * MS.SECOND,
  /** Internal RPC between workers (21.2): connect, keep-alive and the slack added to a call's deadline. */
  rpcConnect: 5 * MS.SECOND,
  rpcKeepAlive: MS.MINUTE,
  rpcDeadlineSlack: 5 * MS.SECOND,
  rpcDefaultCall: 35 * MS.MINUTE,
  /** How often the remote pool looks for idle sessions, and how long a session may sit idle. */
  poolSweep: MS.MINUTE,
  poolIdle: 5 * MS.MINUTE,
  /** How often the instance manager looks for idle sandboxes when timers may have been lost. */
  instanceIdleSweep: 30 * MS.SECOND,
} as const;

/** Sizes of the connection pools Bastion keeps. */
export const POOL_SIZES = {
  /** Connections per installation agent (8.9). */
  agentConnections: 64,
  /** Connections of the internal RPC client. */
  rpcConnections: 128,
} as const;
