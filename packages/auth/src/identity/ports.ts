import type { SigningKeyMeta } from '@bastion-mcp/secrets';
import type { PrincipalRecord, PrincipalType } from './principal';

/** Injectable time source (fake clocks in tests). Same shape as the one in `@bastion-mcp/secrets`. */
export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

/** The subset of a Redis client the identity layer uses. Values are strings; TTLs are seconds. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<boolean>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, fields: Record<string, string>): Promise<void>;
}

/** Redis pub/sub (16.3). `subscribe` returns an unsubscribe function. */
export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): () => void;
}

/** `signing_keys` (16.2) read side; the rotation job lives in `@bastion-mcp/secrets`. */
export interface SigningKeySource {
  listSigningKeys(purpose: 'as'): Promise<SigningKeyMeta[]>;
}

/** Loads the principal record (user or service account with memberships); null when it does not exist. */
export interface PrincipalStore {
  getPrincipal(id: string): Promise<PrincipalRecord | null>;
}

export type RevocationEvent =
  | { kind: 'principal'; principalId: string; at: number }
  | { kind: 'pat'; principalId: string; tokenId: string; tokenSha256: string };

/** `revoked:{principalId}` watermark (epoch seconds) plus the `bastion:revoke` channel (16.3). */
export interface RevocationStore {
  getWatermark(principalId: string): Promise<number | null>;
  setWatermark(principalId: string, epochSeconds: number): Promise<void>;
  publish(event: RevocationEvent): Promise<void>;
}

export type PatRecord = {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  name: string;
  /** Lowercase hex SHA-256 of the full token (the `bytea` column is converted by the adapter). */
  tokenSha256: string;
  scopes: readonly string[];
  endpointId: string | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export interface PatRepository {
  findByHash(tokenSha256: string): Promise<PatRecord | null>;
  findById(id: string): Promise<PatRecord | null>;
  insert(record: PatRecord): Promise<void>;
  listByPrincipal(principalId: string): Promise<PatRecord[]>;
  markRevoked(id: string, at: Date): Promise<void>;
  /** Marks every live PAT of the principal revoked (deactivation). Returns the affected records. */
  revokeAllForPrincipal(principalId: string, at: Date): Promise<PatRecord[]>;
  touchLastUsed(updates: readonly { id: string; at: Date }[]): Promise<void>;
}

/** Org-managed token policy (`settings.tokens.patMaxDays`, 22.5). */
export interface TokenPolicy {
  patMaxDays(): Promise<number>;
}
