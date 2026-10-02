import { newId } from '@bastion-mcp/core';
import { z } from 'zod';
import type {
  OauthClientPolicy,
  PersonalAccessToken,
  ScimToken,
  ServiceAccount,
} from '../generated/client';
import {
  type AuditContext,
  bytesToHex,
  hexToBytes,
  mutate,
  NotFoundError,
  orConflict,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJsonOrNull,
} from './support';

// --- personal_access_tokens (9.3) ------------------------------------------------------------------------------

/** `PatRecord` of `auth/identity/ports.ts`; the `bytea` hash is exposed as lowercase hex. */
export type PatRecord = {
  id: string;
  principalType: 'user' | 'service';
  principalId: string;
  name: string;
  tokenSha256: string;
  scopes: readonly string[];
  endpointId: string | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const principalType = z.enum(['user', 'service']);

const toPat = (row: PersonalAccessToken): PatRecord => ({
  id: row.id,
  principalType: principalType.parse(row.principalType),
  principalId: row.principalId,
  name: row.name,
  tokenSha256: bytesToHex(row.tokenSha256),
  scopes: row.scopes,
  endpointId: row.endpointId,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
});

/** `PatRepository`. Only the SHA-256 of a token is ever stored (22.1). */
export const createPatRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async findByHash(tokenSha256: string): Promise<PatRecord | null> {
      const row = await db.personalAccessToken.findUnique({
        where: { tokenSha256: hexToBytes(tokenSha256) },
      });
      return row ? toPat(row) : null;
    },
    async findById(id: string): Promise<PatRecord | null> {
      const row = await db.personalAccessToken.findUnique({ where: { id } });
      return row ? toPat(row) : null;
    },
    insert(record: PatRecord, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        await orConflict('token', () =>
          tx.personalAccessToken.create({
            data: {
              id: record.id,
              principalType: record.principalType,
              principalId: record.principalId,
              name: record.name,
              tokenSha256: hexToBytes(record.tokenSha256),
              scopes: [...record.scopes],
              endpointId: record.endpointId,
              expiresAt: record.expiresAt,
              lastUsedAt: record.lastUsedAt,
              revokedAt: record.revokedAt,
              createdAt: record.createdAt,
            },
          }),
        );
        unit.audit(audit, {
          action: 'pat.create',
          targetType: 'personal_access_token',
          targetId: record.id,
          diff: {
            before: null,
            after: { name: record.name, scopes: record.scopes, expiresAt: record.expiresAt },
          },
        });
      });
    },
    async listByPrincipal(principalId: string): Promise<PatRecord[]> {
      const rows = await db.personalAccessToken.findMany({
        where: { principalId },
        orderBy: { id: 'desc' },
      });
      return rows.map(toPat);
    },
    markRevoked(id: string, at: Date, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.personalAccessToken.updateMany({
          where: { id, revokedAt: null },
          data: { revokedAt: at },
        });
        if (res.count === 0) return;
        unit.audit(audit, {
          action: 'pat.revoke',
          targetType: 'personal_access_token',
          targetId: id,
          diff: { before: { revokedAt: null }, after: { revokedAt: at } },
        });
      });
    },
    /** Marks every live PAT of the principal revoked (deactivation, 9.1) and returns them. */
    revokeAllForPrincipal(
      principalId: string,
      at: Date,
      audit?: AuditContext,
    ): Promise<PatRecord[]> {
      return mutate(ctx, async (tx, unit) => {
        const live = await tx.personalAccessToken.findMany({
          where: { principalId, revokedAt: null },
          orderBy: { id: 'asc' },
        });
        if (live.length === 0) return [];
        await tx.personalAccessToken.updateMany({
          where: { id: { in: live.map((r) => r.id) }, revokedAt: null },
          data: { revokedAt: at },
        });
        unit.audit(audit, {
          action: 'pat.revoke_all',
          targetType: 'principal',
          targetId: principalId,
          diff: { before: { live: live.length }, after: { live: 0 } },
        });
        return live.map((r) => toPat({ ...r, revokedAt: at }));
      });
    },
    /** Batched `last_used_at` writes (the limiter coalesces them); never moves a stamp backwards. */
    async touchLastUsed(updates: readonly { id: string; at: Date }[]): Promise<void> {
      if (updates.length === 0) return;
      const ids = updates.map((u) => u.id);
      const times = updates.map((u) => u.at);
      await db.$executeRaw`
        UPDATE personal_access_tokens AS p
        SET last_used_at = GREATEST(COALESCE(p.last_used_at, v.at), v.at)
        FROM unnest(${ids}::uuid[], ${times}::timestamptz[]) AS v(id, at)
        WHERE p.id = v.id`;
    },
  };
};

// --- scim_tokens (9.1) ----------------------------------------------------------------------------------------------

export type ScimTokenView = {
  id: string;
  name: string;
  createdBy: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const toScimToken = (row: ScimToken): ScimTokenView => ({
  id: row.id,
  name: row.name,
  createdBy: row.createdBy,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
});

/** `ScimTokenRepository.findByHash` plus the admin operations of the SCIM settings page. */
export const createScimTokenRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async findByHash(
      tokenSha256: string,
    ): Promise<{ id: string; expiresAt: Date | null; revokedAt: Date | null } | null> {
      const row = await db.scimToken.findUnique({
        where: { tokenSha256: hexToBytes(tokenSha256) },
      });
      return row ? { id: row.id, expiresAt: row.expiresAt, revokedAt: row.revokedAt } : null;
    },
    create(
      input: {
        id?: string;
        name: string;
        tokenSha256: string;
        createdBy: string;
        expiresAt?: Date | null;
      },
      audit?: AuditContext,
    ): Promise<ScimTokenView> {
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('SCIM token', () =>
          tx.scimToken.create({
            data: {
              id: input.id ?? newId(),
              name: input.name,
              tokenSha256: hexToBytes(input.tokenSha256),
              createdBy: input.createdBy,
              expiresAt: input.expiresAt ?? null,
            },
          }),
        );
        unit.audit(audit, {
          action: 'scim_token.create',
          targetType: 'scim_token',
          targetId: row.id,
          diff: { before: null, after: { name: row.name } },
        });
        return toScimToken(row);
      });
    },
    async list(): Promise<ScimTokenView[]> {
      const rows = await db.scimToken.findMany({ orderBy: { id: 'desc' } });
      return rows.map(toScimToken);
    },
    revoke(id: string, at: Date, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.scimToken.updateMany({
          where: { id, revokedAt: null },
          data: { revokedAt: at },
        });
        if (res.count === 0) throw new NotFoundError('SCIM token', id);
        unit.audit(audit, {
          action: 'scim_token.revoke',
          targetType: 'scim_token',
          targetId: id,
          diff: { before: { revokedAt: null }, after: { revokedAt: at } },
        });
      });
    },
  };
};

// --- service_accounts (9.3) ------------------------------------------------------------------------------------------

export type ServiceAccountRecord = {
  id: string;
  teamId: string;
  slug: string;
  displayName: string;
  status: 'active' | 'disabled';
  oauthClientId: string | null;
  createdAt: Date;
};

export type ServiceAccountClientRecord = {
  clientId: string;
  serviceAccountId: string;
  authMethod: 'client_secret_basic' | 'private_key_jwt';
  secretSha256: string | null;
  jwks: Record<string, string>[] | null;
};

const saStatus = z.enum(['active', 'disabled']);
const saAuthMethod = z.enum(['client_secret_basic', 'private_key_jwt']);
const jwksSchema = z.array(z.record(z.string(), z.string()));

const toAccount = (row: ServiceAccount): ServiceAccountRecord => ({
  id: row.id,
  teamId: row.teamId,
  slug: row.slug,
  displayName: row.displayName,
  status: saStatus.parse(row.status),
  oauthClientId: row.oauthClientId,
  createdAt: row.createdAt,
});

const toClient = (row: ServiceAccount): ServiceAccountClientRecord | null =>
  row.oauthClientId === null
    ? null
    : {
        clientId: row.oauthClientId,
        serviceAccountId: row.id,
        authMethod: saAuthMethod.parse(row.authMethod),
        secretSha256: row.secretSha256,
        jwks: row.jwks === null ? null : jwksSchema.parse(row.jwks),
      };

/** `ServiceAccountDirectory`: the account and its `client_credentials` client live in one row. */
export const createServiceAccountRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async findByClientId(
      clientId: string,
    ): Promise<{ account: ServiceAccountRecord; client: ServiceAccountClientRecord } | null> {
      const row = await db.serviceAccount.findUnique({ where: { oauthClientId: clientId } });
      const client = row ? toClient(row) : null;
      return row && client ? { account: toAccount(row), client } : null;
    },
    async findById(id: string): Promise<ServiceAccountRecord | null> {
      const row = await db.serviceAccount.findUnique({ where: { id } });
      return row ? toAccount(row) : null;
    },
    async listByTeam(teamId: string): Promise<ServiceAccountRecord[]> {
      const rows = await db.serviceAccount.findMany({
        where: { teamId },
        orderBy: { slug: 'asc' },
      });
      return rows.map(toAccount);
    },
    /** Inserts the account and its client atomically. */
    create(
      account: ServiceAccountRecord,
      client: ServiceAccountClientRecord,
      audit?: AuditContext,
    ): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        await orConflict('service account', () =>
          tx.serviceAccount.create({
            data: {
              id: account.id,
              teamId: account.teamId,
              slug: account.slug,
              displayName: account.displayName,
              status: account.status,
              oauthClientId: client.clientId,
              authMethod: client.authMethod,
              secretSha256: client.secretSha256,
              jwks: toJsonOrNull(client.jwks),
              createdAt: account.createdAt,
            },
          }),
        );
        unit.bump('team', account.teamId);
        unit.audit(audit, {
          action: 'service_account.create',
          targetType: 'service_account',
          targetId: account.id,
          diff: { before: null, after: { slug: account.slug, teamId: account.teamId } },
        });
      });
    },
    /** Rotates the client secret hash or the JWKS of an existing account. */
    saveClient(client: ServiceAccountClientRecord, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.serviceAccount.updateMany({
          where: { id: client.serviceAccountId },
          data: {
            oauthClientId: client.clientId,
            authMethod: client.authMethod,
            secretSha256: client.secretSha256,
            jwks: toJsonOrNull(client.jwks),
            updatedAt: new Date(),
          },
        });
        if (res.count === 0) throw new NotFoundError('service account', client.serviceAccountId);
        unit.audit(audit, {
          action: 'service_account.rotate_credentials',
          targetType: 'service_account',
          targetId: client.serviceAccountId,
          diff: { before: null, after: { authMethod: client.authMethod } },
        });
      });
    },
    setStatus(
      id: string,
      status: ServiceAccountRecord['status'],
      audit?: AuditContext,
    ): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const row = await tx.serviceAccount.findUnique({ where: { id } });
        if (!row) throw new NotFoundError('service account', id);
        await tx.serviceAccount.update({ where: { id }, data: { status } });
        unit.bump('team', row.teamId);
        unit.audit(audit, {
          action: 'service_account.set_status',
          targetType: 'service_account',
          targetId: id,
          diff: { before: { status: row.status }, after: { status } },
        });
      });
    },
  };
};

// --- oauth_client_policies (9.3) -------------------------------------------------------------------------------------

export type OAuthClientPolicy = { clientId: string; preApproved: boolean; blocked: boolean };

const toPolicy = (row: OauthClientPolicy): OAuthClientPolicy => ({
  clientId: row.clientId,
  preApproved: row.preApproved,
  blocked: row.blocked,
});

/** `OAuthClientPolicyStore` (pre-approved and blocked OAuth clients). */
export const createOAuthClientPolicyRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(clientId: string): Promise<OAuthClientPolicy | null> {
      const row = await db.oauthClientPolicy.findUnique({ where: { clientId } });
      return row ? toPolicy(row) : null;
    },
    async list(): Promise<OAuthClientPolicy[]> {
      const rows = await db.oauthClientPolicy.findMany({ orderBy: { clientId: 'asc' } });
      return rows.map(toPolicy);
    },
    upsert(policy: OAuthClientPolicy, updatedBy: string, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const before = await tx.oauthClientPolicy.findUnique({
          where: { clientId: policy.clientId },
        });
        await tx.oauthClientPolicy.upsert({
          where: { clientId: policy.clientId },
          create: {
            clientId: policy.clientId,
            preApproved: policy.preApproved,
            blocked: policy.blocked,
            updatedBy,
          },
          update: {
            preApproved: policy.preApproved,
            blocked: policy.blocked,
            updatedBy,
            updatedAt: new Date(),
          },
        });
        unit.audit(audit, {
          action: 'oauth_client_policy.set',
          targetType: 'oauth_client',
          targetId: policy.clientId,
          diff: {
            before: before ? toPolicy(before) : null,
            after: { preApproved: policy.preApproved, blocked: policy.blocked },
          },
        });
      });
    },
    async delete(clientId: string, audit?: AuditContext): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const res = await tx.oauthClientPolicy.deleteMany({ where: { clientId } });
        if (res.count === 0) return;
        unit.audit(audit, {
          action: 'oauth_client_policy.delete',
          targetType: 'oauth_client',
          targetId: clientId,
          diff: { before: { clientId }, after: null },
        });
      });
    },
  };
};
