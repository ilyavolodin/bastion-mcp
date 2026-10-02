import { randomUUID } from 'node:crypto';
import { generateEs256KeyPair, type SigningKeyMeta } from '@bastion-mcp/secrets';
import type {
  IdpConnection,
  IdpConnectionStore,
  IdpTokenRow,
  IdpTokenStore,
  OAuthClientPolicy,
  OAuthClientPolicyStore,
  OidcModelRow,
  OidcModelStore,
  RedisLike,
  SecretRef,
  SecretStore,
  SigningKeySource,
  UpstreamClientRow,
  UpstreamClientStore,
  UpstreamTokenRow,
  UpstreamTokenStore,
} from '../../src/oauth/ports';

export class MemoryOidcModels implements OidcModelStore {
  readonly rows = new Map<string, OidcModelRow>();
  private key = (type: string, id: string) => `${type}:${id}`;
  async upsert(row: OidcModelRow) {
    this.rows.set(this.key(row.type, row.id), { ...row });
  }
  async find(type: string, id: string) {
    return this.rows.get(this.key(type, id)) ?? null;
  }
  async findByUid(type: string, uid: string) {
    return [...this.rows.values()].find((r) => r.type === type && r.uid === uid) ?? null;
  }
  async findByUserCode(type: string, userCode: string) {
    return [...this.rows.values()].find((r) => r.type === type && r.userCode === userCode) ?? null;
  }
  async consume(type: string, id: string, at: Date) {
    const row = this.rows.get(this.key(type, id));
    if (row) row.consumedAt = at;
  }
  async destroy(type: string, id: string) {
    this.rows.delete(this.key(type, id));
  }
  async revokeByGrantId(grantId: string) {
    for (const [k, r] of this.rows)
      if (r.grantId === grantId && r.type !== 'Grant') this.rows.delete(k);
    for (const [k, r] of this.rows) if (r.type === 'Grant' && r.id === grantId) this.rows.delete(k);
  }
}

export class MemorySigningKeys implements SigningKeySource {
  readonly metas: SigningKeyMeta[] = [];
  private readonly priv = new Map<string, Record<string, string>>();
  add(activeFrom: Date, retireAfter: Date, purpose: 'as' | 'upstream-client' = 'as'): string {
    const pair = generateEs256KeyPair();
    this.metas.push({
      kid: pair.kid,
      purpose,
      alg: 'ES256',
      publicJwk: pair.publicJwk,
      activeFrom,
      retireAfter,
    });
    this.priv.set(pair.kid, pair.privateJwk);
    return pair.kid;
  }
  async listSigningKeys(purpose: 'as' | 'upstream-client') {
    return this.metas.filter((m) => m.purpose === purpose);
  }
  async loadSigningPrivateKey(kid: string) {
    const key = this.priv.get(kid);
    if (!key) throw new Error('unknown kid');
    return key;
  }
}

export class MemoryPolicies implements OAuthClientPolicyStore {
  readonly map = new Map<string, OAuthClientPolicy>();
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async list() {
    return [...this.map.values()];
  }
  async upsert(p: OAuthClientPolicy, _updatedBy?: string) {
    this.map.set(p.clientId, p);
  }
}

export class MemoryRedis implements RedisLike {
  readonly data = new Map<string, string>();
  async incr(key: string) {
    const next = Number(this.data.get(key) ?? '0') + 1;
    this.data.set(key, String(next));
    return next;
  }
  async expire() {
    return true;
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async del(key: string) {
    this.data.delete(key);
  }
}

export class MemorySecrets implements SecretStore {
  readonly byId = new Map<string, string>();
  private readonly byRef = new Map<string, string>();
  private k = (r: SecretRef) => `${r.scope}|${r.ownerId}|${r.name}`;
  async put(ref: SecretRef, value: string) {
    const id = this.byRef.get(this.k(ref)) ?? randomUUID();
    this.byRef.set(this.k(ref), id);
    this.byId.set(id, value);
    return { id };
  }
  async reveal(ref: SecretRef) {
    const id = this.byRef.get(this.k(ref));
    return id ? (this.byId.get(id) ?? null) : null;
  }
  async revealById(id: string) {
    return this.byId.get(id) ?? null;
  }
  async delete(ref: SecretRef) {
    const id = this.byRef.get(this.k(ref));
    if (id) this.byId.delete(id);
    this.byRef.delete(this.k(ref));
  }
}

export class MemoryIdpConnections implements IdpConnectionStore {
  constructor(readonly items: IdpConnection[] = []) {}
  async get(id: string) {
    return this.items.find((c) => c.id === id) ?? null;
  }
  async list() {
    return this.items;
  }
}

export class MemoryIdpTokens implements IdpTokenStore {
  readonly rows = new Map<string, IdpTokenRow>();
  async get(u: string, c: string) {
    return this.rows.get(`${u}:${c}`) ?? null;
  }
  async put(row: IdpTokenRow) {
    this.rows.set(`${row.userId}:${row.idpConnectionId}`, row);
  }
  async delete(u: string, c: string) {
    this.rows.delete(`${u}:${c}`);
  }
}

export class MemoryUpstreamClients implements UpstreamClientStore {
  readonly rows = new Map<string, UpstreamClientRow>();
  async get(issuer: string) {
    return this.rows.get(issuer) ?? null;
  }
  async put(row: UpstreamClientRow) {
    this.rows.set(row.issuer, row);
  }
  async delete(issuer: string) {
    this.rows.delete(issuer);
  }
}

export class MemoryUpstreamTokens implements UpstreamTokenStore {
  readonly rows = new Map<string, UpstreamTokenRow>();
  async get(p: string, i: string) {
    return this.rows.get(`${p}:${i}`) ?? null;
  }
  async put(row: UpstreamTokenRow) {
    this.rows.set(`${row.principalId}:${row.installationId}`, row);
  }
  async delete(p: string, i: string) {
    this.rows.delete(`${p}:${i}`);
  }
  async listExpiringBefore(before: Date) {
    return [...this.rows.values()].filter(
      (r) => r.status === 'valid' && r.expiresAt !== null && r.expiresAt < before,
    );
  }
  async listByPrincipal(principalId: string) {
    return [...this.rows.values()].filter((r) => r.principalId === principalId);
  }
  async listByInstallation(installationId: string) {
    return [...this.rows.values()].filter((r) => r.installationId === installationId);
  }
}
