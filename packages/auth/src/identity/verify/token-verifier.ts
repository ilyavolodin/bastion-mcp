import { MS, REDIS_CHANNELS, TTL, TtlCache } from '@bastion-mcp/core';
import { buildJwks, type SigningKeyMeta } from '@bastion-mcp/secrets';
import { createLocalJWKSet, decodeProtectedHeader, type JWK, jwtVerify } from 'jose';
import { z } from 'zod';
import { AuthenticationError, InsufficientScopeError } from '../errors';
import { hashPatToken, looksLikePat, PAT_PATTERN } from '../pat/token';
import {
  type Clock,
  type PatRecord,
  type PatRepository,
  type PrincipalStore,
  type PubSub,
  type RevocationStore,
  type SigningKeySource,
  systemClock,
} from '../ports';
import { buildPrincipal, type Principal, type PrincipalRecord } from '../principal';
import { buildChallenge, type Surface, scopeAllowed, surfaceForPath } from './surface';

const KEY_RELOAD_MIN_INTERVAL_MS = 30 * MS.SECOND;
const CLOCK_TOLERANCE_S = 5;
const CACHE_MAX = 10_000;

export type TokenVerifierOptions = {
  /** `https://<host>`; only its value is trusted, never the request's Host header. */
  baseUrl: string;
  /** Authorization server issuer, `https://<host>/oauth` (9.3). */
  issuer: string;
  clock?: Clock;
  keys: SigningKeySource;
  principals: PrincipalStore;
  revocations: RevocationStore;
  pats: PatRepository;
  /** Resolves the endpoint id addressed by the request (7.1) so PAT endpoint restrictions are enforced here. */
  resolveEndpointId?: (url: URL) => Promise<string | null>;
};

const claimsSchema = z.object({
  sub: z.string().min(1),
  scope: z.string().default(''),
  iat: z.number(),
  client_id: z.string().optional(),
  jti: z.string().optional(),
  'bastion:pt': z.enum(['user', 'service']).optional(),
});

const configEventSchema = z.object({ topic: z.string() });
const revokeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('principal'), principalId: z.string() }),
  z.object({ kind: z.literal('pat'), principalId: z.string(), tokenSha256: z.string() }),
]);

type Credential = { token: string; basic: boolean };

/** 4.4 / 9.3 token verification: JWT access tokens and personal access tokens. */
export class TokenVerifier {
  private readonly clock: Clock;
  private keyCache: { keys: SigningKeyMeta[]; loadedAt: number } | null = null;
  private readonly principalCache: TtlCache<string, PrincipalRecord>;
  private readonly patCache: TtlCache<string, PatRecord>;
  private readonly lastUsed = new Map<string, Date>();

  constructor(private readonly opts: TokenVerifierOptions) {
    this.clock = opts.clock ?? systemClock;
    this.principalCache = new TtlCache({
      ttlMs: TTL.principalCache * MS.SECOND,
      max: CACHE_MAX,
      clock: this.clock,
    });
    this.patCache = new TtlCache({
      ttlMs: TTL.patCache * MS.SECOND,
      max: CACHE_MAX,
      clock: this.clock,
    });
  }

  /** Verifies the `Authorization` header for a request URL and returns the principal. */
  async verify(authorization: string | undefined, requestUrl: string): Promise<Principal> {
    const url = new URL(requestUrl);
    const surface = surfaceForPath(url.pathname);
    if (surface === null) {
      throw new InsufficientScopeError(
        'resource is not a Bastion resource server path',
        this.challenge('mcp', url, 'insufficient_scope'),
        'mcp',
      );
    }
    const cred = this.parseCredential(authorization, surface, url);
    const principal = looksLikePat(cred.token)
      ? await this.verifyPat(cred.token, surface, url)
      : await this.verifyJwt(cred.token, surface, url);
    return principal;
  }

  /** Drops the cached principal so the next request reloads it (revocation, deactivation). */
  invalidatePrincipal(principalId: string): void {
    this.principalCache.delete(principalId);
  }

  /** Forces the JWKS to reload on the next request. */
  invalidateKeys(): void {
    this.keyCache = null;
  }

  /** Reloads keys on `bastion:config` events with topic `signing_keys` (9.3). */
  watchConfigEvents(bus: PubSub): () => void {
    return bus.subscribe(REDIS_CHANNELS.config, (message) => {
      const parsed = parseJson(message, configEventSchema);
      if (parsed?.topic === 'signing_keys') this.invalidateKeys();
    });
  }

  /** Evicts cached principals and PATs on `bastion:revoke` events. */
  watchRevocations(bus: PubSub): () => void {
    return bus.subscribe(REDIS_CHANNELS.revoke, (message) => {
      const parsed = parseJson(message, revokeEventSchema);
      if (!parsed) return;
      this.invalidatePrincipal(parsed.principalId);
      if (parsed.kind === 'pat') this.patCache.delete(parsed.tokenSha256);
    });
  }

  /** Writes the batched `last_used_at` updates (call every few seconds from the shell). */
  async flushLastUsed(): Promise<void> {
    if (this.lastUsed.size === 0) return;
    const updates = [...this.lastUsed].map(([id, at]) => ({ id, at }));
    this.lastUsed.clear();
    await this.opts.pats.touchLastUsed(updates);
  }

  private challenge(
    surface: Surface,
    url: URL,
    error?: 'invalid_token' | 'insufficient_scope',
    basic = false,
  ): string {
    return buildChallenge({
      surface,
      baseUrl: this.opts.baseUrl,
      pathname: url.pathname,
      ...(error ? { error } : {}),
      basic,
    });
  }

  private invalid(surface: Surface, url: URL, reason: string): AuthenticationError {
    return new AuthenticationError(
      'INVALID_TOKEN',
      'invalid access token',
      this.challenge(surface, url, 'invalid_token'),
      reason,
    );
  }

  private insufficient(surface: Surface, url: URL, message: string): InsufficientScopeError {
    return new InsufficientScopeError(
      message,
      this.challenge(surface, url, 'insufficient_scope'),
      this.requiredScope(surface),
    );
  }

  private requiredScope(surface: Surface): string {
    return surface === 'mcp' ? 'mcp' : surface === 'api' ? 'api:read' : 'plugins:read';
  }

  private parseCredential(header: string | undefined, surface: Surface, url: URL): Credential {
    const missing = () =>
      new AuthenticationError(
        'UNAUTHENTICATED',
        'authentication required',
        this.challenge(surface, url, undefined, surface === 'plugins'),
      );
    if (!header) throw missing();
    const space = header.indexOf(' ');
    const scheme = (space < 0 ? header : header.slice(0, space)).toLowerCase();
    const value = space < 0 ? '' : header.slice(space + 1).trim();
    if (!value) throw missing();
    if (scheme === 'bearer') return { token: value, basic: false };
    if (scheme === 'basic' && surface === 'plugins') {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const password = colon < 0 ? '' : decoded.slice(colon + 1);
      if (password) return { token: password, basic: true };
    }
    throw this.invalid(surface, url, 'unsupported authorization scheme');
  }

  /* ------------------------------- JWT ------------------------------- */

  private async loadKeys(force: boolean): Promise<SigningKeyMeta[]> {
    const now = this.clock.now();
    if (force || !this.keyCache || now - this.keyCache.loadedAt >= TTL.jwksCache * MS.SECOND) {
      this.keyCache = { keys: await this.opts.keys.listSigningKeys('as'), loadedAt: now };
    }
    return this.keyCache.keys;
  }

  private async liveJwks(kid: string | undefined): Promise<JWK[]> {
    const now = new Date(this.clock.now());
    let keys = await this.loadKeys(false);
    let live = buildJwks(keys, now).keys;
    const known = (list: Record<string, string>[]) => list.some((k) => k.kid === kid);
    if (kid && !known(live) && this.keyCache) {
      if (this.clock.now() - this.keyCache.loadedAt >= KEY_RELOAD_MIN_INTERVAL_MS) {
        keys = await this.loadKeys(true);
        live = buildJwks(keys, now).keys;
      }
    }
    return live;
  }

  private async verifyJwt(token: string, surface: Surface, url: URL): Promise<Principal> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw this.invalid(surface, url, 'malformed token');
    }
    const jwks = await this.liveJwks(kid);
    let payload: unknown;
    try {
      const result = await jwtVerify(token, createLocalJWKSet({ keys: jwks }), {
        issuer: this.opts.issuer,
        algorithms: ['ES256'],
        typ: 'at+jwt',
        currentDate: new Date(this.clock.now()),
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['exp', 'iat', 'sub', 'aud'],
      });
      payload = result.payload;
    } catch (e) {
      throw this.invalid(surface, url, e instanceof Error ? e.name : 'verification failed');
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw this.invalid(surface, url, 'malformed claims');
    const aud = (payload as { aud?: unknown }).aud;
    if (!this.audienceMatches(aud, surface, url)) throw this.invalid(surface, url, 'audience');

    const scopes = claims.data.scope.split(' ').filter(Boolean);
    // A deactivated principal is invalid_token whatever its scopes, so check it first.
    const record = await this.activePrincipal(claims.data.sub, surface, url);
    if (!scopeAllowed(surface, scopes)) {
      throw this.insufficient(surface, url, `scope ${this.requiredScope(surface)} required`);
    }
    if (claims.data['bastion:pt'] && claims.data['bastion:pt'] !== record.type) {
      throw this.invalid(surface, url, 'principal type mismatch');
    }
    await this.assertNotRevoked(record.id, claims.data.iat, surface, url);
    return buildPrincipal(record, {
      authMethod: 'oauth',
      clientId: claims.data.client_id ?? null,
      scopes,
      credentialId: claims.data.jti ?? null,
    });
  }

  /** `aud` is a surface resource URL that equals or is a path prefix of the request URL (9.3). */
  private audienceMatches(aud: unknown, surface: Surface, url: URL): boolean {
    const list = Array.isArray(aud) ? aud : [aud];
    const base = new URL(this.opts.baseUrl);
    return list.some((a) => {
      if (typeof a !== 'string') return false;
      let u: URL;
      try {
        u = new URL(a);
      } catch {
        return false;
      }
      const path = u.pathname.replace(/\/+$/, '');
      return (
        u.origin === base.origin &&
        !u.search &&
        !u.hash &&
        surfaceForPath(path) === surface &&
        (url.pathname === path || url.pathname.startsWith(`${path}/`))
      );
    });
  }

  private async activePrincipal(id: string, surface: Surface, url: URL): Promise<PrincipalRecord> {
    let record = this.principalCache.get(id) ?? null;
    if (!record) {
      record = await this.opts.principals.getPrincipal(id);
      if (record) this.principalCache.set(id, record);
    }
    if (!record?.active) throw this.invalid(surface, url, 'principal inactive');
    return record;
  }

  /** A credential issued (whole seconds) at or before the principal's revocation watermark is dead (9.1). */
  private async assertNotRevoked(
    principalId: string,
    issuedAtSeconds: number,
    surface: Surface,
    url: URL,
  ): Promise<void> {
    const watermark = await this.opts.revocations.getWatermark(principalId);
    if (watermark !== null && issuedAtSeconds <= watermark) {
      throw this.invalid(surface, url, 'revoked');
    }
  }

  /* -------------------------------- PAT -------------------------------- */

  private async verifyPat(token: string, surface: Surface, url: URL): Promise<Principal> {
    if (!PAT_PATTERN.test(token)) throw this.invalid(surface, url, 'malformed pat');
    const hash = hashPatToken(token);
    const now = this.clock.now();
    let pat = this.patCache.get(hash) ?? null;
    if (!pat) {
      pat = await this.opts.pats.findByHash(hash);
      if (pat) this.patCache.set(hash, pat);
    }
    if (!pat) throw this.invalid(surface, url, 'unknown pat');
    if (pat.revokedAt !== null) throw this.invalid(surface, url, 'revoked');
    if (pat.expiresAt.getTime() <= now) throw this.invalid(surface, url, 'expired');
    const record = await this.activePrincipal(pat.principalId, surface, url);
    if (!scopeAllowed(surface, pat.scopes)) {
      throw this.insufficient(surface, url, `scope ${this.requiredScope(surface)} required`);
    }
    if (record.type !== pat.principalType) throw this.invalid(surface, url, 'principal type');
    await this.assertNotRevoked(
      record.id,
      Math.floor(pat.createdAt.getTime() / MS.SECOND),
      surface,
      url,
    );
    if (pat.endpointId && this.opts.resolveEndpointId) {
      const endpoint = await this.opts.resolveEndpointId(url);
      if (endpoint !== pat.endpointId) {
        throw this.insufficient(surface, url, 'token is restricted to another endpoint');
      }
    }
    this.lastUsed.set(pat.id, new Date(now));
    return buildPrincipal(record, {
      authMethod: 'pat',
      scopes: pat.scopes,
      endpointRestriction: pat.endpointId,
      credentialId: pat.id,
    });
  }
}

const parseJson = <T>(message: string, schema: z.ZodType<T>): T | null => {
  try {
    const r = schema.safeParse(JSON.parse(message));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};
