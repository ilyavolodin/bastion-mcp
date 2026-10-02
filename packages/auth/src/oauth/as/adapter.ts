import { AeadError, type Keyring, openJson, sealJson } from '@bastion-mcp/core';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Clock, OAuthClientPolicyStore, OidcModelRow, OidcModelStore } from '../ports';

const SECRET_PREFIX = 'bcs1.';

export type AdapterOptions = {
  store: OidcModelStore;
  clock: Clock;
  /** Blocked clients are reported as unknown (9.3). */
  policies?: OAuthClientPolicyStore;
  /** When present, `client_secret` values are envelope-sealed inside the stored payload (22.3). */
  secretKeyring?: Keyring;
};

const GRANT_LINKED = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

/**
 * Adapter factory for oidc-provider over the `oidc_models` table shape (16.2). `consumed` is derived from
 * `consumed_at`; rows past `expires_at` are treated as absent.
 */
export const createOidcAdapterClass = (
  options: AdapterOptions,
): (new (
  name: string,
) => Adapter) => {
  const { store, clock, policies, secretKeyring } = options;

  const sealSecret = (payload: AdapterPayload): AdapterPayload => {
    const secret = payload.client_secret;
    if (!secretKeyring || typeof secret !== 'string') return payload;
    const { client_secret: _omit, ...rest } = payload;
    return {
      ...rest,
      client_secret_sealed: sealJson({ s: secret }, secretKeyring, { prefix: SECRET_PREFIX }),
    };
  };

  const openSecret = (payload: Record<string, unknown>): Record<string, unknown> => {
    const sealed = payload.client_secret_sealed;
    if (!secretKeyring || typeof sealed !== 'string') return payload;
    const { client_secret_sealed: _omit, ...rest } = payload;
    try {
      const opened = openJson(sealed, secretKeyring, { prefix: SECRET_PREFIX }) as { s?: unknown };
      return typeof opened.s === 'string' ? { ...rest, client_secret: opened.s } : rest;
    } catch (error) {
      if (error instanceof AeadError) return rest;
      throw error;
    }
  };

  const toPayload = (row: OidcModelRow | null): AdapterPayload | undefined => {
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= clock.now()) return undefined;
    const base = row.type === 'Client' ? openSecret(row.payload) : row.payload;
    return row.consumedAt
      ? { ...base, consumed: Math.floor(row.consumedAt.getTime() / 1000) }
      : (base as AdapterPayload);
  };

  return class BastionOidcAdapter implements Adapter {
    constructor(private readonly name: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      const stored = this.name === 'Client' ? sealSecret(payload) : payload;
      const { consumed: _c, ...clean } = stored as Record<string, unknown>;
      await store.upsert({
        id,
        type: this.name,
        payload: clean,
        grantId: typeof payload.grantId === 'string' ? payload.grantId : null,
        userCode: typeof payload.userCode === 'string' ? payload.userCode : null,
        uid: typeof payload.uid === 'string' ? payload.uid : null,
        expiresAt: expiresIn > 0 ? new Date(clock.now() + expiresIn * 1000) : null,
        consumedAt: null,
      });
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.name === 'Client' && policies) {
        const policy = await policies.get(id);
        if (policy?.blocked) return undefined;
      }
      return toPayload(await store.find(this.name, id));
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return toPayload(await store.findByUid(this.name, uid));
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      return toPayload(await store.findByUserCode(this.name, userCode));
    }

    async consume(id: string): Promise<void> {
      await store.consume(this.name, id, new Date(clock.now()));
    }

    async destroy(id: string): Promise<void> {
      await store.destroy(this.name, id);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      if (GRANT_LINKED.has(this.name) || this.name === 'Grant')
        await store.revokeByGrantId(grantId);
    }
  };
};
