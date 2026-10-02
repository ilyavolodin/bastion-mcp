import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
} from 'jose';
import { z } from 'zod';
import type { IdJagVerifier } from '../as/id-jag-grant';
import type { FetchFn, IdpConnection, IdpConnectionStore } from '../ports';
import { type Clock, systemClock } from '../ports';
import { discoveryDocument } from './discovery';

export class IdJagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdJagError';
  }
}

const idJagClaims = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  resource: z.union([z.string(), z.array(z.string())]),
  client_id: z.string(),
  jti: z.string().min(1),
  exp: z.number(),
});

const JWKS_TTL_MS = 5 * 60 * 1000;
const ALLOWED_TYP = new Set(['oauth-id-jag+jwt', 'jwt']);

/** One-time use of `jti` values (replay protection). */
export interface JtiGuard {
  /** Returns false when the jti was already seen. */
  consume(jti: string, ttlSeconds: number): Promise<boolean>;
}

export class MemoryJtiGuard implements JtiGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly clock: Clock = systemClock) {}
  async consume(jti: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock.now();
    for (const [key, until] of this.seen) if (until <= now) this.seen.delete(key);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, now + ttlSeconds * 1000);
    return true;
  }
}

export type IdJagVerifierDeps = {
  connections: IdpConnectionStore;
  fetch: FetchFn;
  clock?: Clock;
  /** Maps the verified `sub` to a Bastion user (JIT provisioning when allowed); null refuses. */
  resolveUser: (
    connection: IdpConnection,
    claims: { sub: string; [claim: string]: unknown },
  ) => Promise<{ userId: string } | null>;
  jti?: JtiGuard;
  allowInsecureHttp?: boolean;
};

/**
 * Verifies an ID-JAG against the IdP connection's JWKS (9.4): `iss`, `aud` (this AS), `exp`, `resource`
 * and the `client_id` claim equal to the authenticating client; then maps `sub` to a user.
 */
export const createIdJagVerifier = (deps: IdJagVerifierDeps): IdJagVerifier => {
  const clock = deps.clock ?? systemClock;
  const jtiGuard = deps.jti ?? new MemoryJtiGuard(clock);
  const jwksCache = new Map<string, { at: number; jwks: JSONWebKeySet }>();

  const loadJwks = async (connection: IdpConnection, force: boolean): Promise<JSONWebKeySet> => {
    const cached = jwksCache.get(connection.id);
    if (!force && cached && clock.now() - cached.at < JWKS_TTL_MS) return cached.jwks;
    const doc = await discoveryDocument(connection.discoveryUrl, deps.fetch);
    const response = await deps.fetch(doc.jwks_uri, { headers: { accept: 'application/json' } });
    if (response.status !== 200) throw new IdJagError('IdP JWKS is not reachable');
    const jwks = (await response.json()) as JSONWebKeySet;
    jwksCache.set(connection.id, { at: clock.now(), jwks });
    return jwks;
  };

  return {
    async verify(assertion, expect) {
      let issuer: string;
      try {
        issuer = String(decodeJwt(assertion).iss ?? '');
      } catch {
        throw new IdJagError('assertion is not a JWT');
      }
      const connections = await deps.connections.list();
      const connection = connections.find(
        (c) => c.enabled && c.enterpriseManagedAuth && c.issuer === issuer,
      );
      if (!connection) throw new IdJagError('no IdP connection allows ID-JAG from this issuer');
      const typ = (decodeProtectedHeader(assertion).typ ?? 'JWT').toLowerCase();
      if (!ALLOWED_TYP.has(typ)) throw new IdJagError('unexpected assertion type');
      const options = {
        issuer: connection.issuer,
        audience: expect.audience,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
        clockTolerance: 30,
        currentDate: new Date(clock.now()),
      };
      let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
      try {
        try {
          ({ payload } = await jwtVerify(
            assertion,
            createLocalJWKSet(await loadJwks(connection, false)),
            options,
          ));
        } catch {
          // Key rotation: refetch the JWKS once.
          ({ payload } = await jwtVerify(
            assertion,
            createLocalJWKSet(await loadJwks(connection, true)),
            options,
          ));
        }
      } catch {
        throw new IdJagError('assertion signature or claims are invalid');
      }
      const claims = idJagClaims.safeParse(payload);
      if (!claims.success) throw new IdJagError('assertion is missing required claims');
      const resources = Array.isArray(claims.data.resource)
        ? claims.data.resource
        : [claims.data.resource];
      if (!resources.includes(expect.resource)) throw new IdJagError('resource does not match');
      if (claims.data.client_id !== expect.clientId)
        throw new IdJagError('client_id does not match the client');
      const ttl = Math.max(1, Math.ceil(claims.data.exp - clock.now() / 1000) + 30);
      if (!(await jtiGuard.consume(`${connection.id}:${claims.data.jti}`, ttl))) {
        throw new IdJagError('assertion was already used');
      }
      const user = await deps.resolveUser(connection, { ...payload, sub: claims.data.sub });
      if (!user) throw new IdJagError('subject is not a Bastion user');
      return user;
    },
  };
};
