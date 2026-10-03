import {
  AuthenticationError,
  buildPrincipal,
  type PatRecord,
  type PatRepository,
  PatService,
  type Principal,
  type PrincipalStore,
  type RedisLike,
  type RevocationEvent,
  type RevocationStore,
} from '@bastion-mcp/auth';
import { UnavailableApiError } from '../../../src/errors';
import type { ApiEvent, EventBus, Publisher, SecretMeta, SecretsPort } from '../../../src/ports';
import { ACTORS, type ActorName, PRINCIPAL_RECORDS, tokenFor } from '../world';

export class MemoryRedis implements RedisLike {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async expire() {
    return true;
  }
  async hgetall() {
    return {};
  }
  async hset() {}
}

export class RecordingPublisher implements Publisher {
  readonly messages: Array<{ channel: string; message: string }> = [];
  async publish(channel: string, message: string) {
    this.messages.push({ channel, message });
  }
}

export class MemoryEventBus implements EventBus {
  readonly published: ApiEvent[] = [];
  private readonly handlers = new Set<(event: ApiEvent) => void>();
  publish(event: ApiEvent) {
    this.published.push(event);
    for (const h of this.handlers) h(event);
  }
  subscribe(handler: (event: ApiEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export const principalFor = (
  actor: Exclude<ActorName, 'anonymous'>,
  scopes: readonly string[] = ['api:read', 'api:write'],
): Principal =>
  buildPrincipal(PRINCIPAL_RECORDS[actor], { authMethod: 'pat', scopes, credentialId: 'pat-1' });

const CHALLENGE =
  'Bearer resource_metadata="https://bastion.test/.well-known/oauth-protected-resource/api", scope="api:read"';

/** `Authorization: Bearer tok-<actor>[:read]`; the `:read` suffix issues a read-only token. */
export const fakeTokens = () => ({
  async verify(authorization: string | undefined, _url: string): Promise<Principal> {
    if (!authorization) {
      throw new AuthenticationError('UNAUTHENTICATED', 'authentication required', CHALLENGE);
    }
    const token = authorization.replace(/^Bearer /i, '');
    const [name, flag] = token.split(':');
    const actor = ACTORS.find((a) => a !== 'anonymous' && tokenFor(a) === name);
    if (!actor || actor === 'anonymous') {
      throw new AuthenticationError('INVALID_TOKEN', 'invalid access token', CHALLENGE);
    }
    return principalFor(actor, flag === 'read' ? ['api:read'] : ['api:read', 'api:write']);
  },
});

/** The CSRF token the fake session store issued with session `sid`. */
export const sessionCsrfToken = (sid: string): string => `csrf-of-${sid}`;

export const fakeSessions = () => ({
  async checkCsrf(sid: string, presented: string | undefined): Promise<boolean> {
    return presented !== undefined && presented === sessionCsrfToken(sid);
  },
  async authenticate(sid: string): Promise<Principal | null> {
    const actor = ACTORS.find((a) => a !== 'anonymous' && `sid-${a}` === sid);
    if (!actor || actor === 'anonymous') return null;
    return buildPrincipal(PRINCIPAL_RECORDS[actor], {
      authMethod: 'session',
      scopes: ['api:read', 'api:write'],
    });
  },
});

export const fakePrincipalStore = (): PrincipalStore => ({
  async getPrincipal(id) {
    return Object.values(PRINCIPAL_RECORDS).find((r) => r.id === id) ?? null;
  },
});

type SecretKeyLike = { scope: 'org' | 'team' | 'user'; ownerId: string | null; name: string };

export class MemorySecrets implements SecretsPort {
  readonly rows = new Map<string, SecretMeta & { value: string }>();
  private key(k: SecretKeyLike) {
    return `${k.scope}/${k.ownerId ?? ''}/${k.name}`;
  }
  async list(filter: {
    scope: 'org' | 'team' | 'user';
    ownerId: string | null;
  }): Promise<SecretMeta[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.scope === filter.scope && (filter.ownerId === null || r.ownerId === filter.ownerId),
      )
      .map(({ value: _value, ...meta }) => meta);
  }
  async put(key: SecretKeyLike & { value: string }): Promise<SecretMeta> {
    const existing = this.rows.get(this.key(key));
    const now = '2026-01-01T00:00:00.000Z';
    const row = {
      id: existing?.id ?? `secret-${this.rows.size + 1}`,
      scope: key.scope,
      ownerId: key.ownerId,
      name: key.name,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      value: key.value,
    };
    this.rows.set(this.key(key), row);
    const { value: _value, ...meta } = row;
    return meta;
  }
  async delete(key: SecretKeyLike): Promise<boolean> {
    return this.rows.delete(this.key(key));
  }
}

/** A port the test did not configure: any call fails loudly instead of returning invented data. */
export const notConfigured = <T extends object>(name: string): T =>
  new Proxy({} as T, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return () => {
        throw new UnavailableApiError(`${name}.${String(prop)}`);
      };
    },
  });

export class MemoryPatRepository implements PatRepository {
  readonly rows = new Map<string, PatRecord>();
  async findByHash(hash: string) {
    return [...this.rows.values()].find((r) => r.tokenSha256 === hash) ?? null;
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async insert(record: PatRecord) {
    this.rows.set(record.id, record);
  }
  async listByPrincipal(principalId: string) {
    return [...this.rows.values()].filter((r) => r.principalId === principalId);
  }
  async markRevoked(id: string, at: Date) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, revokedAt: at });
  }
  async revokeAllForPrincipal(principalId: string, at: Date) {
    const hit = [...this.rows.values()].filter(
      (r) => r.principalId === principalId && !r.revokedAt,
    );
    for (const r of hit) this.rows.set(r.id, { ...r, revokedAt: at });
    return hit;
  }
  async touchLastUsed() {}
}

export class MemoryRevocations implements RevocationStore {
  readonly events: RevocationEvent[] = [];
  readonly watermarks = new Map<string, number>();
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

/** The real `PatService` over in-memory repositories. */
export const makePatService = (clock: { now(): Date }) => {
  const pats = new MemoryPatRepository();
  const revocations = new MemoryRevocations();
  const service = new PatService({
    pats,
    revocations,
    policy: { patMaxDays: async () => 90 },
    clock: { now: () => clock.now().getTime() },
  });
  return { service, pats, revocations };
};
