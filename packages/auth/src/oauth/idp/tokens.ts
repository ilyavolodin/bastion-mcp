import * as client from 'openid-client';
import { z } from 'zod';
import { TOKEN_SKEW_MS } from '../constants';
import { toProtocolError } from '../http';
import {
  type Clock,
  type IdpTokenStore,
  type SecretRef,
  type SecretStore,
  systemClock,
} from '../ports';
import { type IdpClients, type IdpTokenSet, toTokenSet } from './login';

const tokenSetSchema = z.object({
  accessToken: z.string(),
  idToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number().nullable(),
  scope: z.string().nullable(),
});

const secretRef = (userId: string, connectionId: string): SecretRef => ({
  scope: 'user',
  ownerId: userId,
  name: `idp-tokens:${connectionId}`,
});

export class IdpRefreshError extends Error {
  constructor(
    message: string,
    readonly kind: 'no_session' | 'refused' | 'unavailable',
    readonly description?: string,
  ) {
    super(message);
    this.name = 'IdpRefreshError';
  }
}

/** IdP tokens, envelope-encrypted in the secrets table and indexed by `idp_tokens` (9.7, 16.2). */
export class IdpTokenVault {
  private readonly clock: Clock;
  constructor(
    private readonly deps: { store: IdpTokenStore; secrets: SecretStore; clock?: Clock },
  ) {
    this.clock = deps.clock ?? systemClock;
  }

  async save(userId: string, connectionId: string, tokens: IdpTokenSet): Promise<void> {
    const { id } = await this.deps.secrets.put(
      secretRef(userId, connectionId),
      JSON.stringify(tokens),
    );
    await this.deps.store.put({
      userId,
      idpConnectionId: connectionId,
      secretId: id,
      expiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
      updatedAt: new Date(this.clock.now()),
    });
  }

  async load(userId: string, connectionId: string): Promise<IdpTokenSet | null> {
    const raw = await this.deps.secrets.reveal(secretRef(userId, connectionId));
    if (raw === null) return null;
    return tokenSetSchema.parse(JSON.parse(raw));
  }

  async delete(userId: string, connectionId: string): Promise<void> {
    await this.deps.secrets.delete(secretRef(userId, connectionId));
    await this.deps.store.delete(userId, connectionId);
  }
}

/**
 * Returns usable IdP tokens for the user, refreshing with the stored refresh token when the access token
 * is close to expiry or when `forceRefresh` is set (an ID token is only available right after a refresh
 * or login). When the IdP returns no ID token on refresh, `idToken` is null (9.7).
 */
export const refreshIdpTokens = async (input: {
  clients: IdpClients;
  vault: IdpTokenVault;
  clock?: Clock;
  userId: string;
  connectionId: string;
  forceRefresh?: boolean;
}): Promise<IdpTokenSet> => {
  const clock = input.clock ?? systemClock;
  const current = await input.vault.load(input.userId, input.connectionId);
  if (!current) throw new IdpRefreshError('no stored IdP session', 'no_session');
  const fresh = current.expiresAt === null || current.expiresAt - clock.now() > TOKEN_SKEW_MS;
  if (fresh && !input.forceRefresh) return current;
  if (!current.refreshToken)
    throw new IdpRefreshError('IdP session has no refresh token', 'no_session');
  const connection = await input.clients.connection(input.connectionId);
  let config: client.Configuration;
  try {
    config = await input.clients.configuration(connection);
  } catch (error) {
    throw new IdpRefreshError(
      'IdP is unreachable',
      'unavailable',
      toProtocolError(error, 'discovery').message,
    );
  }
  try {
    const response = await client.refreshTokenGrant(
      config,
      current.refreshToken,
      connection.apiScope ? { scope: scopeForRefresh(connection.apiScope) } : undefined,
    );
    const next = toTokenSet(response, clock.now(), current);
    await input.vault.save(input.userId, input.connectionId, next);
    return next;
  } catch (error) {
    const protocol = toProtocolError(error, 'IdP refresh failed');
    if (protocol.status !== undefined && protocol.status >= 400 && protocol.status < 500) {
      throw new IdpRefreshError(
        protocol.message,
        'refused',
        protocol.description ?? protocol.error,
      );
    }
    throw new IdpRefreshError(protocol.message, 'unavailable');
  }
};

const scopeForRefresh = (apiScope: string): string => `openid offline_access ${apiScope}`.trim();
