import { randomBytes } from 'node:crypto';
import {
  CLIENT_ID_PREFIX,
  generateClientSecret,
  hashClientSecret,
  validateClientJwks,
} from '@bastion-mcp/auth';
import { isValidSlug, sha256Hex } from '@bastion-mcp/core';
import { ConflictApiError, NotFoundApiError, ValidationApiError } from '../errors';
import type { IdpTestResult } from '../ports';
import type { Row } from '../ports/store';
import { CrudService, nowIso, type ReadCtx, type WriteCtx } from './crud';

const SCIM_TOKEN_PREFIX = 'bst_scim_';
const DAY_MS = 86_400_000;

// --- service accounts (9.3) -------------------------------------------------------------------------------

export const serviceAccounts = new CrudService({
  collection: 'service_accounts',
  targetType: 'service_account',
  action: 'service_account',
  configTopic: 'service_accounts',
});

type CredentialResult = {
  clientId: string;
  authMethod: 'client_secret_basic' | 'private_key_jwt';
  clientSecret?: string;
};

const parseJwks = (jwks: unknown): Record<string, string>[] => {
  try {
    return validateClientJwks(jwks);
  } catch (error) {
    throw new ValidationApiError(error instanceof Error ? error.message : 'invalid jwks', [
      { path: '/jwks', message: 'invalid public keys' },
    ]);
  }
};

export const createServiceAccount = async (
  ctx: WriteCtx,
  body: {
    teamId: string;
    slug: string;
    displayName: string;
    authMethod: 'client_secret_basic' | 'private_key_jwt';
    jwks?: Record<string, string>[] | undefined;
  },
): Promise<Row & CredentialResult> => {
  if (!isValidSlug(body.slug)) {
    throw new ValidationApiError('the slug is not valid', [
      { path: '/slug', message: 'use lowercase letters, digits and dashes' },
    ]);
  }
  if (!(await ctx.tx.store.get('teams', body.teamId))) throw new NotFoundApiError('team');
  const clash = await ctx.tx.store.find('service_accounts', {
    teamId: body.teamId,
    slug: body.slug,
  });
  if (clash.length > 0) throw new ConflictApiError('a service account with this slug exists');
  if (body.authMethod === 'private_key_jwt' && !body.jwks) {
    throw new ValidationApiError('private_key_jwt needs jwks', [
      { path: '/jwks', message: 'required' },
    ]);
  }
  const clientId = `${CLIENT_ID_PREFIX}${randomBytes(12).toString('base64url')}`;
  const secret = body.authMethod === 'client_secret_basic' ? generateClientSecret() : undefined;
  const id = ctx.deps.newId();
  const account = await ctx.tx.store.insert('service_accounts', {
    id,
    teamId: body.teamId,
    slug: body.slug,
    displayName: body.displayName,
    status: 'active',
    oauthClientId: clientId,
    createdAt: nowIso(ctx.deps),
  });
  await ctx.tx.store.insert('service_account_clients', {
    id: clientId,
    serviceAccountId: id,
    authMethod: body.authMethod,
    secretSha256: secret ? hashClientSecret(secret) : null,
    jwks: body.authMethod === 'private_key_jwt' ? parseJwks(body.jwks) : null,
  });
  await ctx.tx.audit({
    action: 'service_account.create',
    targetType: 'service_account',
    targetId: id,
    diff: { teamId: body.teamId, slug: body.slug, authMethod: body.authMethod },
  });
  ctx.tx.configChanged('service_accounts');
  return {
    ...account,
    clientId,
    authMethod: body.authMethod,
    ...(secret ? { clientSecret: secret } : {}),
  };
};

export const deleteServiceAccount = async (ctx: WriteCtx, id: string): Promise<void> => {
  const account = await ctx.tx.store.get('service_accounts', id);
  if (!account) throw new NotFoundApiError('service account');
  const clients = await ctx.tx.store.find('service_account_clients', { serviceAccountId: id });
  for (const client of clients) await ctx.tx.store.remove('service_account_clients', client.id);
  await serviceAccounts.remove(ctx, id);
  await ctx.deps.pats.revokeAll(id);
};

/** Rotates the client secret (shown once) or replaces the registered public keys (9.3). */
export const rotateCredentials = async (
  ctx: WriteCtx,
  id: string,
  body: { jwks?: Record<string, string>[] | undefined },
): Promise<CredentialResult> => {
  const account = await ctx.tx.store.get('service_accounts', id);
  if (!account) throw new NotFoundApiError('service account');
  const [client] = await ctx.tx.store.find('service_account_clients', { serviceAccountId: id });
  if (!client) throw new NotFoundApiError('service account client');
  let result: CredentialResult;
  if (body.jwks) {
    await ctx.tx.store.update('service_account_clients', client.id, {
      authMethod: 'private_key_jwt',
      secretSha256: null,
      jwks: parseJwks(body.jwks),
    });
    result = { clientId: client.id, authMethod: 'private_key_jwt' };
  } else {
    if (client.authMethod !== 'client_secret_basic') {
      throw new ValidationApiError(
        'this account authenticates with a key; send jwks to replace it',
        [{ path: '/jwks', message: 'required' }],
      );
    }
    const secret = generateClientSecret();
    await ctx.tx.store.update('service_account_clients', client.id, {
      secretSha256: hashClientSecret(secret),
    });
    result = { clientId: client.id, authMethod: 'client_secret_basic', clientSecret: secret };
  }
  await ctx.deps.pats.revokeAll(id);
  await ctx.tx.audit({
    action: 'service_account.credentials.rotate',
    targetType: 'service_account',
    targetId: id,
    diff: { authMethod: result.authMethod },
  });
  ctx.tx.configChanged('service_accounts');
  return result;
};

// --- identity providers (9.1) -----------------------------------------------------------------------------

export const idpConnections = new CrudService({
  collection: 'idp_connections',
  targetType: 'idp_connection',
  action: 'idp_connection',
  configTopic: 'idp_connections',
});

const idpSecretName = (id: string): string => `idp-client-secret/${id}`;

export const createIdp = async (
  ctx: WriteCtx,
  body: { clientSecret: string } & Record<string, unknown>,
): Promise<Row> => {
  const { clientSecret, ...fields } = body;
  const id = ctx.deps.newId();
  const meta = await ctx.deps.secrets.put({
    scope: 'org',
    ownerId: null,
    name: idpSecretName(id),
    value: clientSecret,
  });
  return idpConnections.create(ctx, { ...fields, clientSecretId: meta.id }, id);
};

export const updateIdp = async (
  ctx: WriteCtx,
  id: string,
  patch: { clientSecret?: string | undefined } & Record<string, unknown>,
): Promise<Row> => {
  const { clientSecret, ...fields } = patch;
  await idpConnections.require(ctx, id);
  const changes: Record<string, unknown> = { ...fields };
  if (clientSecret !== undefined) {
    const meta = await ctx.deps.secrets.put({
      scope: 'org',
      ownerId: null,
      name: idpSecretName(id),
      value: clientSecret,
    });
    changes.clientSecretId = meta.id;
  }
  return idpConnections.update(ctx, id, changes);
};

export const deleteIdp = async (ctx: WriteCtx, id: string): Promise<void> => {
  await idpConnections.remove(ctx, id);
  await ctx.deps.secrets.delete({ scope: 'org', ownerId: null, name: idpSecretName(id) });
};

/** `POST /idp-connections/{id}/test`: fetches the discovery document and checks the issuer (9.1). */
export const testIdp = async (
  ctx: ReadCtx & { signal: AbortSignal },
  id: string,
): Promise<IdpTestResult> => {
  const row = await idpConnections.require(ctx, id);
  return ctx.deps.identity.testIdp(
    { issuer: String(row.issuer), discoveryUrl: String(row.discoveryUrl) },
    ctx.signal,
  );
};

// --- SCIM tokens (9.1) --------------------------------------------------------------------------------------

export const scimTokens = new CrudService({
  collection: 'scim_tokens',
  targetType: 'scim_token',
  action: 'scim_token',
  view: ({ tokenSha256: _hash, ...rest }) => rest as Row,
});

/** The secret is returned once; only its SHA-256 is stored (matches `ScimService.authenticate`). */
export const createScimToken = async (
  ctx: WriteCtx,
  body: { name: string; expiresInDays?: number | undefined },
): Promise<Row & { token: string }> => {
  const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const now = ctx.deps.clock.now();
  const row = await scimTokens.create(ctx, {
    name: body.name,
    tokenSha256: sha256Hex(token),
    createdBy: ctx.principal.id,
    expiresAt: body.expiresInDays
      ? new Date(now.getTime() + body.expiresInDays * DAY_MS).toISOString()
      : null,
    revokedAt: null,
  });
  return { ...row, token };
};

/** Revoking keeps the row for the audit trail (9.1). */
export const revokeScimToken = async (ctx: WriteCtx, id: string): Promise<void> => {
  const row = await ctx.tx.store.get('scim_tokens', id);
  if (!row) throw new NotFoundApiError('scim token');
  await ctx.tx.store.update('scim_tokens', id, { revokedAt: nowIso(ctx.deps) });
  await ctx.tx.audit({ action: 'scim_token.revoke', targetType: 'scim_token', targetId: id });
};

// --- OAuth client policies (9.4) ------------------------------------------------------------------------------

export const oauthClients = new CrudService({
  collection: 'oauth_clients',
  targetType: 'oauth_client',
  action: 'oauth_client',
  configTopic: 'oauth_clients',
});

export const registerOauthClient = async (
  ctx: WriteCtx,
  body: { clientId: string; preApproved: boolean; blocked: boolean },
): Promise<Row> => {
  if (await ctx.tx.store.get('oauth_clients', body.clientId)) {
    throw new ConflictApiError('this client already has a policy');
  }
  return oauthClients.create(
    ctx,
    {
      clientId: body.clientId,
      preApproved: body.preApproved,
      blocked: body.blocked,
      updatedBy: ctx.principal.id,
    },
    body.clientId,
  );
};
