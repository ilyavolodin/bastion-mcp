import { generateEs256KeyPair, type SigningKeyMeta } from '@bastion-mcp/secrets';
import { importJWK, SignJWT } from 'jose';
import type {
  Clock,
  PatRecord,
  PatRepository,
  PrincipalRecord,
  PrincipalStore,
  PubSub,
  RedisLike,
  RevocationEvent,
  RevocationStore,
  SigningKeySource,
} from '../../src/identity';

export class FakeClock implements Clock {
  constructor(public ms = Date.parse('2026-06-01T12:00:00Z')) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  get seconds(): number {
    return Math.floor(this.ms / 1000);
  }
}

export class MemoryRedis implements RedisLike {
  readonly strings = new Map<string, { value: string; expiresAt: number | null }>();
  readonly hashes = new Map<string, { fields: Record<string, string>; expiresAt: number | null }>();
  constructor(private readonly clock: Clock) {}
  private alive(expiresAt: number | null): boolean {
    return expiresAt === null || expiresAt > this.clock.now();
  }
  async get(key: string) {
    const e = this.strings.get(key);
    return e && this.alive(e.expiresAt) ? e.value : null;
  }
  async set(key: string, value: string, ttlSeconds?: number) {
    this.strings.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.clock.now() + ttlSeconds * 1000,
    });
  }
  async del(key: string) {
    this.strings.delete(key);
    this.hashes.delete(key);
  }
  async expire(key: string, ttlSeconds: number) {
    const h = this.hashes.get(key);
    if (h && this.alive(h.expiresAt)) {
      h.expiresAt = this.clock.now() + ttlSeconds * 1000;
      return true;
    }
    return false;
  }
  async hgetall(key: string) {
    const h = this.hashes.get(key);
    return h && this.alive(h.expiresAt) ? { ...h.fields } : {};
  }
  async hset(key: string, fields: Record<string, string>) {
    const h = this.hashes.get(key);
    this.hashes.set(key, {
      fields: { ...(h?.fields ?? {}), ...fields },
      expiresAt: h?.expiresAt ?? null,
    });
  }
  ttlMs(key: string): number | null {
    const h = this.hashes.get(key);
    return h?.expiresAt == null ? null : h.expiresAt - this.clock.now();
  }
}

export class MemoryPubSub implements PubSub {
  readonly published: { channel: string; message: string }[] = [];
  private readonly handlers = new Map<string, Set<(m: string) => void>>();
  async publish(channel: string, message: string) {
    this.published.push({ channel, message });
    for (const h of this.handlers.get(channel) ?? []) h(message);
  }
  subscribe(channel: string, handler: (message: string) => void) {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
}

export class MemoryRevocations implements RevocationStore {
  readonly watermarks = new Map<string, number>();
  readonly events: RevocationEvent[] = [];
  async getWatermark(id: string) {
    return this.watermarks.get(id) ?? null;
  }
  async setWatermark(id: string, at: number) {
    this.watermarks.set(id, at);
  }
  async publish(event: RevocationEvent) {
    this.events.push(event);
  }
}

export class MemoryPrincipals implements PrincipalStore {
  readonly records = new Map<string, PrincipalRecord>();
  lookups = 0;
  async getPrincipal(id: string) {
    this.lookups++;
    return this.records.get(id) ?? null;
  }
}

export class MemoryPats implements PatRepository {
  readonly rows = new Map<string, PatRecord>();
  lookups = 0;
  touched: { id: string; at: Date }[][] = [];
  async findByHash(h: string) {
    this.lookups++;
    return [...this.rows.values()].find((r) => r.tokenSha256 === h) ?? null;
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async insert(r: PatRecord) {
    this.rows.set(r.id, r);
  }
  async listByPrincipal(pid: string) {
    return [...this.rows.values()].filter((r) => r.principalId === pid);
  }
  async markRevoked(id: string, at: Date) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, revokedAt: at });
  }
  async revokeAllForPrincipal(pid: string, at: Date) {
    const out: PatRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.principalId === pid && r.revokedAt === null) {
        const n = { ...r, revokedAt: at };
        this.rows.set(r.id, n);
        out.push(n);
      }
    }
    return out;
  }
  async touchLastUsed(updates: readonly { id: string; at: Date }[]) {
    this.touched.push([...updates]);
    for (const u of updates) {
      const r = this.rows.get(u.id);
      if (r) this.rows.set(u.id, { ...r, lastUsedAt: u.at });
    }
  }
}

export class MemoryKeySource implements SigningKeySource {
  keys: SigningKeyMeta[] = [];
  loads = 0;
  async listSigningKeys() {
    this.loads++;
    return this.keys;
  }
}

export type TestKey = ReturnType<typeof generateEs256KeyPair>;

export const makeKey = (
  clock: Clock,
  opts: { activeDays?: number; retireInDays?: number } = {},
) => {
  const pair = generateEs256KeyPair();
  const meta: SigningKeyMeta = {
    kid: pair.kid,
    purpose: 'as',
    alg: 'ES256',
    publicJwk: pair.publicJwk,
    activeFrom: new Date(clock.now() - (opts.activeDays ?? 1) * 86_400_000),
    retireAfter: new Date(clock.now() + (opts.retireInDays ?? 37) * 86_400_000),
  };
  return { pair, meta };
};

export type ClaimOverrides = Record<string, unknown>;

export const signAccessToken = async (
  pair: TestKey,
  clock: Clock,
  claims: ClaimOverrides = {},
  header: { typ?: string; alg?: string; kid?: string } = {},
  opts: { iss?: string; aud?: string | string[]; exp?: number; iat?: number } = {},
): Promise<string> => {
  const key = await importJWK(pair.privateJwk, 'ES256');
  const iat = opts.iat ?? Math.floor(clock.now() / 1000);
  return new SignJWT({
    scope: 'mcp',
    client_id: 'client-1',
    'bastion:pt': 'user',
    ...claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: header.typ ?? 'at+jwt',
      kid: header.kid ?? pair.kid,
    })
    .setIssuer(opts.iss ?? 'https://bastion.test/oauth')
    .setSubject((claims.sub as string | undefined) ?? 'user-1')
    .setAudience(opts.aud ?? 'https://bastion.test/mcp')
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 900)
    .setJti('jti-1')
    .sign(key);
};

export const memberRecord = (id: string, over: Partial<PrincipalRecord> = {}): PrincipalRecord => ({
  id,
  type: 'user',
  orgRole: 'member',
  teams: [],
  active: true,
  ...over,
});
