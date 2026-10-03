import { newId, UPSTREAM_TOKEN_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { IdpConnection as IdpConnectionRow, UpstreamToken } from '../generated/client';
import {
  type AuditContext,
  assertIfMatch,
  assertSwapped,
  compact,
  etagOf,
  jsonObjectSchema,
  mutate,
  NotFoundError,
  nextUpdatedAt,
  orConflict,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  versionGuard,
} from './support';

// --- oidc_models (9.2: oidc-provider adapter storage) ---------------------------------------------------------

/** `OidcModelRow` of `auth/oauth/ports.ts`. */
export type OidcModelRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  grantId: string | null;
  userCode: string | null;
  uid: string | null;
  expiresAt: Date | null;
  consumedAt: Date | null;
};

export const createOidcModelStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  const toRow = (r: {
    id: string;
    type: string;
    payload: unknown;
    grantId: string | null;
    userCode: string | null;
    uid: string | null;
    expiresAt: Date | null;
    consumedAt: Date | null;
  }): OidcModelRow => ({ ...r, payload: jsonObjectSchema.parse(r.payload) });
  return {
    async upsert(row: OidcModelRow): Promise<void> {
      const data = {
        payload: toJson(row.payload),
        grantId: row.grantId,
        userCode: row.userCode,
        uid: row.uid,
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt,
      };
      await db.oidcModel.upsert({
        where: { type_id: { type: row.type, id: row.id } },
        create: { id: row.id, type: row.type, ...data },
        update: data,
      });
    },
    async find(type: string, id: string): Promise<OidcModelRow | null> {
      const row = await db.oidcModel.findUnique({ where: { type_id: { type, id } } });
      return row ? toRow(row) : null;
    },
    async findByUid(type: string, uid: string): Promise<OidcModelRow | null> {
      const row = await db.oidcModel.findFirst({ where: { type, uid } });
      return row ? toRow(row) : null;
    },
    async findByUserCode(type: string, userCode: string): Promise<OidcModelRow | null> {
      const row = await db.oidcModel.findFirst({ where: { type, userCode } });
      return row ? toRow(row) : null;
    },
    async consume(type: string, id: string, at: Date): Promise<void> {
      await db.oidcModel.updateMany({ where: { type, id }, data: { consumedAt: at } });
    },
    async destroy(type: string, id: string): Promise<void> {
      await db.oidcModel.deleteMany({ where: { type, id } });
    },
    /** Deletes every row whose `grant_id` matches (any type). */
    async revokeByGrantId(grantId: string): Promise<void> {
      await db.oidcModel.deleteMany({ where: { grantId } });
    },
    /** Retention sweep: removes rows past `expires_at`. Returns how many were deleted. */
    async purgeExpired(now: Date): Promise<number> {
      const res = await db.oidcModel.deleteMany({ where: { expiresAt: { lt: now } } });
      return res.count;
    },
  };
};

// --- idp_connections (9.1) -----------------------------------------------------------------------------------------

export type ClaimMap = { email: string; name: string; groups: string; sub: string };

const claimMapSchema = z.object({
  email: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  groups: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
});

export const DEFAULT_CLAIM_MAP: ClaimMap = {
  email: 'email',
  name: 'name',
  groups: 'groups',
  sub: 'sub',
};

/** `IdpConnection` of `auth/oauth/ports.ts` (a superset of the one provisioning uses). */
export type IdpConnectionRecord = {
  id: string;
  name: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretId: string;
  scopes: readonly string[];
  claimMap: ClaimMap;
  emailDomains: readonly string[];
  storeRefreshToken: boolean;
  apiScope: string | null;
  enterpriseManagedAuth: boolean;
  /** The IdP only accepts the site origin as redirect URI: sign-in returns to `/` (9.1). */
  redirectToRoot: boolean;
  enabled: boolean;
};

const toIdp = (row: IdpConnectionRow): IdpConnectionRecord => ({
  id: row.id,
  name: row.name,
  issuer: row.issuer,
  discoveryUrl: row.discoveryUrl,
  clientId: row.clientId,
  clientSecretId: row.clientSecretId,
  scopes: row.scopes,
  claimMap: {
    ...DEFAULT_CLAIM_MAP,
    ...compact<Partial<ClaimMap>>(claimMapSchema.parse(row.claimMap)),
  },
  emailDomains: row.emailDomains,
  storeRefreshToken: row.storeRefreshToken,
  apiScope: row.apiScope,
  enterpriseManagedAuth: row.enterpriseManagedAuth,
  redirectToRoot: row.redirectToRoot,
  enabled: row.enabled,
});

export type IdpConnectionInput = Omit<IdpConnectionRecord, 'id' | 'claimMap'> & {
  id?: string;
  claimMap?: Partial<ClaimMap>;
};

export const createIdpConnectionRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<IdpConnectionRecord | null> {
      const row = await db.idpConnection.findUnique({ where: { id } });
      return row ? toIdp(row) : null;
    },
    async getWithEtag(
      id: string,
    ): Promise<{ connection: IdpConnectionRecord; etag: string } | null> {
      const row = await db.idpConnection.findUnique({ where: { id } });
      return row ? { connection: toIdp(row), etag: etagOf(row) } : null;
    },
    async list(): Promise<IdpConnectionRecord[]> {
      const rows = await db.idpConnection.findMany({ orderBy: { id: 'asc' } });
      return rows.map(toIdp);
    },
    async count(): Promise<number> {
      return db.idpConnection.count();
    },
    async create(input: IdpConnectionInput, audit?: AuditContext): Promise<IdpConnectionRecord> {
      const claimMap = claimMapSchema.parse(input.claimMap ?? {});
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('identity provider', () =>
          tx.idpConnection.create({
            data: {
              id: input.id ?? newId(),
              name: input.name,
              issuer: input.issuer,
              discoveryUrl: input.discoveryUrl,
              clientId: input.clientId,
              clientSecretId: input.clientSecretId,
              scopes: [...input.scopes],
              claimMap: toJson(claimMap),
              emailDomains: [...input.emailDomains],
              storeRefreshToken: input.storeRefreshToken,
              apiScope: input.apiScope,
              enterpriseManagedAuth: input.enterpriseManagedAuth,
              redirectToRoot: input.redirectToRoot,
              enabled: input.enabled,
            },
          }),
        );
        unit.bump('org');
        unit.audit(audit, {
          action: 'idp.create',
          targetType: 'idp_connection',
          targetId: row.id,
          diff: { before: null, after: { name: row.name, issuer: row.issuer } },
        });
        return toIdp(row);
      });
    },
    update(
      id: string,
      patch: Partial<Omit<IdpConnectionInput, 'id'>>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<IdpConnectionRecord> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.idpConnection.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('identity provider', id);
        assertIfMatch(current, opts.ifMatch);
        const { claimMap, scopes, emailDomains, ...rest } = patch;
        assertSwapped(
          await tx.idpConnection.updateMany({
            where: { id, ...versionGuard(current) },
            data: {
              ...rest,
              ...(scopes === undefined ? {} : { scopes: [...scopes] }),
              ...(emailDomains === undefined ? {} : { emailDomains: [...emailDomains] }),
              ...(claimMap === undefined
                ? {}
                : { claimMap: toJson(claimMapSchema.parse(claimMap)) }),
              updatedAt: nextUpdatedAt(current),
            },
          }),
        );
        const row = await tx.idpConnection.findUniqueOrThrow({ where: { id } });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'idp.update',
          targetType: 'idp_connection',
          targetId: id,
          diff: { before: toIdp(current), after: toIdp(row) },
        });
        return toIdp(row);
      });
    },
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.idpConnection.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('identity provider', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(
          await tx.idpConnection.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'idp.delete',
          targetType: 'idp_connection',
          targetId: id,
          diff: { before: { name: current.name }, after: null },
        });
      });
    },
  };
};

// --- idp_tokens (9.1) ------------------------------------------------------------------------------------------------

export type IdpTokenRow = {
  userId: string;
  idpConnectionId: string;
  secretId: string;
  expiresAt: Date | null;
  updatedAt: Date;
};

export const createIdpTokenStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  return {
    async get(userId: string, idpConnectionId: string): Promise<IdpTokenRow | null> {
      return db.idpToken.findUnique({
        where: { userId_idpConnectionId: { userId, idpConnectionId } },
      });
    },
    async put(row: IdpTokenRow): Promise<void> {
      const data = { secretId: row.secretId, expiresAt: row.expiresAt, updatedAt: row.updatedAt };
      await db.idpToken.upsert({
        where: {
          userId_idpConnectionId: { userId: row.userId, idpConnectionId: row.idpConnectionId },
        },
        create: { userId: row.userId, idpConnectionId: row.idpConnectionId, ...data },
        update: data,
      });
    },
    async delete(userId: string, idpConnectionId: string): Promise<void> {
      await db.idpToken.deleteMany({ where: { userId, idpConnectionId } });
    },
  };
};

// --- upstream_clients (9.6) --------------------------------------------------------------------------------------------

export type UpstreamClientRow = {
  issuer: string;
  registration: 'preRegistered' | 'cimd' | 'dcr';
  clientId: string;
  clientSecretId: string | null;
  metadata: Record<string, unknown>;
};

const registration = z.enum(['preRegistered', 'cimd', 'dcr']);

export const createUpstreamClientStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  return {
    async get(issuer: string): Promise<UpstreamClientRow | null> {
      const row = await db.upstreamClient.findUnique({ where: { issuer } });
      if (!row) return null;
      return {
        issuer: row.issuer,
        registration: registration.parse(row.registration),
        clientId: row.clientId,
        clientSecretId: row.clientSecretId,
        metadata: jsonObjectSchema.parse(row.metadata),
      };
    },
    async put(row: UpstreamClientRow): Promise<void> {
      const data = {
        registration: row.registration,
        clientId: row.clientId,
        clientSecretId: row.clientSecretId,
        metadata: toJson(row.metadata),
      };
      await db.upstreamClient.upsert({
        where: { issuer: row.issuer },
        create: { id: newId(), issuer: row.issuer, ...data },
        update: data,
      });
    },
    async delete(issuer: string): Promise<void> {
      await db.upstreamClient.deleteMany({ where: { issuer } });
    },
  };
};

// --- upstream_tokens (9.6) ----------------------------------------------------------------------------------------------

export type UpstreamTokenRow = {
  principalType: 'user' | 'service';
  principalId: string;
  installationId: string;
  issuer: string;
  secretId: string;
  scopes: readonly string[];
  expiresAt: Date | null;
  status: (typeof UPSTREAM_TOKEN_STATUSES)[number];
  updatedAt: Date;
};

const tokenStatus = z.enum(UPSTREAM_TOKEN_STATUSES);
const tokenPrincipal = z.enum(['user', 'service']);

const toToken = (row: UpstreamToken): UpstreamTokenRow => ({
  principalType: tokenPrincipal.parse(row.principalType),
  principalId: row.principalId,
  installationId: row.installationId,
  issuer: row.issuer,
  secretId: row.secretId,
  scopes: row.scopes,
  expiresAt: row.expiresAt,
  status: tokenStatus.parse(row.status),
  updatedAt: row.updatedAt,
});

export const createUpstreamTokenStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  return {
    async get(principalId: string, installationId: string): Promise<UpstreamTokenRow | null> {
      const row = await db.upstreamToken.findFirst({ where: { principalId, installationId } });
      return row ? toToken(row) : null;
    },
    async put(row: UpstreamTokenRow): Promise<void> {
      const data = {
        issuer: row.issuer,
        secretId: row.secretId,
        scopes: [...row.scopes],
        expiresAt: row.expiresAt,
        status: row.status,
        updatedAt: row.updatedAt,
      };
      await db.upstreamToken.upsert({
        where: {
          principalType_principalId_installationId: {
            principalType: row.principalType,
            principalId: row.principalId,
            installationId: row.installationId,
          },
        },
        create: {
          id: newId(),
          principalType: row.principalType,
          principalId: row.principalId,
          installationId: row.installationId,
          ...data,
        },
        update: data,
      });
    },
    async delete(principalId: string, installationId: string): Promise<void> {
      await db.upstreamToken.deleteMany({ where: { principalId, installationId } });
    },
    /** Rows expiring before `before` that are still `valid` (daily sweep). */
    async listExpiringBefore(before: Date): Promise<UpstreamTokenRow[]> {
      const rows = await db.upstreamToken.findMany({
        where: { status: 'valid', expiresAt: { lt: before } },
        orderBy: { expiresAt: 'asc' },
      });
      return rows.map(toToken);
    },
    async listByInstallation(installationId: string): Promise<UpstreamTokenRow[]> {
      const rows = await db.upstreamToken.findMany({
        where: { installationId },
        orderBy: { id: 'asc' },
      });
      return rows.map(toToken);
    },
    /** Every installation token of one principal (deactivation, 9.1). */
    async listByPrincipal(principalId: string): Promise<UpstreamTokenRow[]> {
      const rows = await db.upstreamToken.findMany({
        where: { principalId },
        orderBy: { id: 'asc' },
      });
      return rows.map(toToken);
    },
  };
};
