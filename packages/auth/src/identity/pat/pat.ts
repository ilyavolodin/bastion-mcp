import { MS, newId } from '@bastion-mcp/core';
import { z } from 'zod';
import { IdentityNotFoundError, IdentityValidationError } from '../errors';
import {
  type Clock,
  type PatRecord,
  type PatRepository,
  type RevocationStore,
  systemClock,
  type TokenPolicy,
} from '../ports';
import type { PrincipalType } from '../principal';
import { generatePatToken, hashPatToken } from './token';

/** Default PAT lifetime (9.3, 22.5), further capped by the admin maximum. */
export const DEFAULT_PAT_DAYS = 90;
/** `offline_access` is never valid on a PAT (no refresh). */
export const PAT_SCOPES = ['mcp', 'api:read', 'api:write', 'plugins:read'] as const;

const createSchema = z.object({
  principalId: z.string().min(1),
  principalType: z.enum(['user', 'service']),
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(PAT_SCOPES)).min(1),
  expiresInDays: z.number().positive().optional(),
  endpointId: z.string().min(1).optional(),
});

export type CreatePatInput = {
  principalId: string;
  principalType: PrincipalType;
  name: string;
  scopes: readonly string[];
  expiresInDays?: number;
  endpointId?: string;
};

export type PatMetadata = Omit<PatRecord, 'tokenSha256'> & { revoked: boolean };

export type PatServiceDeps = {
  pats: PatRepository;
  revocations: RevocationStore;
  policy: TokenPolicy;
  clock?: Clock;
  random?: (n: number) => Uint8Array;
};

export class PatService {
  private readonly clock: Clock;
  constructor(private readonly deps: PatServiceDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Creates a PAT. The secret is returned once and never stored (9.3). */
  async create(input: CreatePatInput): Promise<{ token: string; record: PatRecord }> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
      throw new IdentityValidationError('invalid token request', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const max = await this.deps.policy.patMaxDays();
    const days = parsed.data.expiresInDays ?? Math.min(DEFAULT_PAT_DAYS, max);
    if (days > max) {
      throw new IdentityValidationError(`token lifetime exceeds the maximum of ${max} days`, {
        maxDays: max,
      });
    }
    const token = generatePatToken(this.deps.random);
    const now = this.clock.now();
    const record: PatRecord = {
      id: newId(now),
      principalType: parsed.data.principalType,
      principalId: parsed.data.principalId,
      name: parsed.data.name,
      tokenSha256: hashPatToken(token),
      scopes: [...new Set(parsed.data.scopes)],
      endpointId: parsed.data.endpointId ?? null,
      expiresAt: new Date(now + days * MS.DAY),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(now),
    };
    await this.deps.pats.insert(record);
    return { token, record };
  }

  async list(principalId: string): Promise<PatMetadata[]> {
    const rows = await this.deps.pats.listByPrincipal(principalId);
    return rows.map(({ tokenSha256: _hash, ...meta }) => ({
      ...meta,
      revoked: meta.revokedAt !== null,
    }));
  }

  /** Revokes one PAT and tells workers to evict their cache (`bastion:revoke`). */
  async revoke(tokenId: string, opts: { ownerId?: string }): Promise<void> {
    const pat = await this.deps.pats.findById(tokenId);
    if (!pat || (opts.ownerId !== undefined && pat.principalId !== opts.ownerId)) {
      throw new IdentityNotFoundError('token not found');
    }
    if (pat.revokedAt === null) {
      await this.deps.pats.markRevoked(pat.id, new Date(this.clock.now()));
    }
    await this.deps.revocations.publish({
      kind: 'pat',
      principalId: pat.principalId,
      tokenId: pat.id,
      tokenSha256: pat.tokenSha256,
    });
  }

  /**
   * Principal-wide revocation (deactivation, 9.1): writes the revoked watermark so every access
   * token, session and PAT issued up to now stops working, revokes the PAT rows and publishes.
   */
  async revokeAll(principalId: string): Promise<void> {
    const now = new Date(this.clock.now());
    const at = Math.floor(now.getTime() / MS.SECOND);
    await this.deps.revocations.setWatermark(principalId, at);
    const revoked = await this.deps.pats.revokeAllForPrincipal(principalId, now);
    for (const pat of revoked) {
      await this.deps.revocations.publish({
        kind: 'pat',
        principalId,
        tokenId: pat.id,
        tokenSha256: pat.tokenSha256,
      });
    }
    await this.deps.revocations.publish({ kind: 'principal', principalId, at });
  }
}
