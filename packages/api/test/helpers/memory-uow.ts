import type { AuditActor, AuditDescriptor, Tx, UnitOfWork } from '../../src/ports';
import type { MemoryStore } from './memory-store';

export type RecordedAudit = AuditDescriptor & AuditActor;

/** Transactions over the in-memory store: rollback on throw, hooks and audit rows only on commit. */
export class MemoryUnitOfWork implements UnitOfWork {
  readonly audits: RecordedAudit[] = [];
  constructor(private readonly store: MemoryStore) {}

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const snapshot = this.store.snapshot();
    const pending: RecordedAudit[] = [];
    const hooks: Array<() => Promise<void> | void> = [];
    const tx: Tx = {
      store: this.store,
      audit: async (event) => {
        pending.push(event);
      },
      afterCommit: (hook) => {
        hooks.push(hook);
      },
    };
    try {
      const out = await fn(tx);
      this.audits.push(...pending);
      for (const hook of hooks) await hook();
      return out;
    } catch (error) {
      this.store.restore(snapshot);
      throw error;
    }
  }
}
