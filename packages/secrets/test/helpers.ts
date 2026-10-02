import { randomBytes } from 'node:crypto';
import type {
  Clock,
  KmsProvider,
  SecretKey,
  SecretMetadata,
  SecretRecord,
  SecretRepository,
  SecretScope,
  SecretWrite,
  WrappedDekRow,
} from '../src';

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** XOR "KMS" good enough for tests; can be switched off to simulate an outage. */
export class FakeKms implements KmsProvider {
  down = false;
  unwrapCalls = 0;
  wrapCalls = 0;
  constructor(
    public kekRef = 'fake:v1',
    public mask = randomBytes(32),
  ) {}
  private xor(b: Buffer): Buffer {
    return Buffer.from(b.map((x, i) => x ^ (this.mask[i % 32] ?? 0)));
  }
  async wrap(dek: Buffer): Promise<Buffer> {
    this.wrapCalls++;
    if (this.down) throw new Error('kms down');
    return this.xor(dek);
  }
  async unwrap(wrapped: Buffer, _kekRef: string): Promise<Buffer> {
    this.unwrapCalls++;
    if (this.down) throw new Error('kms down');
    return this.xor(wrapped);
  }
  async health() {
    return { ok: !this.down };
  }
}

const keyOf = (k: SecretKey) => `${k.scope}|${k.ownerId ?? ''}|${k.name}`;

export class MemoryRepo implements SecretRepository {
  rows = new Map<string, SecretRecord>();
  async get(key: SecretKey) {
    return this.rows.get(keyOf(key)) ?? null;
  }
  async put(w: SecretWrite): Promise<SecretMetadata> {
    const prev = this.rows.get(keyOf(w));
    const rec: SecretRecord = {
      ...w,
      createdAt: prev?.createdAt ?? new Date(0),
      updatedAt: prev ? new Date(1) : null,
    };
    this.rows.set(keyOf(w), rec);
    return rec;
  }
  async delete(key: SecretKey) {
    return this.rows.delete(keyOf(key));
  }
  async listMetadata(f: { scope: SecretScope; ownerId: string | null }) {
    // Deliberately returns full records so the vault's stripping is tested.
    return [...this.rows.values()].filter((r) => r.scope === f.scope && r.ownerId === f.ownerId);
  }
  async listWrappedDeksNotUnder(
    ref: string,
    limit: number,
    afterId?: string,
  ): Promise<WrappedDekRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.kekRef !== ref && (afterId === undefined || r.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ id: r.id, wrappedDek: r.wrappedDek, kekRef: r.kekRef }));
  }
  async updateWrappedDek(id: string, wrappedDek: Buffer, kekRef: string) {
    for (const [k, r] of this.rows) if (r.id === id) this.rows.set(k, { ...r, wrappedDek, kekRef });
  }
}
