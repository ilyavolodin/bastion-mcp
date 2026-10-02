import type { ResourceStore } from './store';

/** What a route reports as its audit event (15.6); the framework adds actor, ip, user agent, request id. */
export type AuditDescriptor = {
  action: string;
  targetType: string;
  targetId?: string | null;
  diff?: unknown;
};

export type AuditActor = {
  actorType: 'user' | 'service' | 'system';
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
};

/** One database transaction (17.1: audit in the same transaction). */
export interface Tx {
  readonly store: ResourceStore;
  /** Appends to the hash chain inside this transaction (`appendAuditEvent`, 15.6). */
  audit(event: AuditDescriptor & AuditActor): Promise<void>;
  /** Runs after COMMIT only (publish `bastion:config`, SSE events); never after a rollback. */
  afterCommit(hook: () => Promise<void> | void): void;
}

export interface UnitOfWork {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Fire-and-forget publisher for Redis channels (`bastion:config`, 16.3). */
export interface Publisher {
  publish(channel: string, message: string): Promise<void>;
}
