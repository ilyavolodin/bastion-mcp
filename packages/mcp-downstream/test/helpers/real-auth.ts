/** A real `TokenVerifier` (ES256 JWTs, personal access tokens) over in-memory stores, for the security tests (23.3). */
import {
  type PatRepository,
  type PrincipalRecord,
  type PrincipalStore,
  type RevocationEvent,
  type RevocationStore,
  type SigningKeySource,
  TokenVerifier,
} from '@bastion-mcp/auth';
import { generateEs256KeyPair, type SigningKeyMeta } from '@bastion-mcp/secrets';
import { importJWK, SignJWT } from 'jose';

export const NOW_MS = (): number => Date.now();

export class MemoryRevocations implements RevocationStore {
  readonly watermarks = new Map<string, number>();
  async getWatermark(id: string): Promise<number | null> {
    return this.watermarks.get(id) ?? null;
  }
  async setWatermark(id: string, at: number): Promise<void> {
    this.watermarks.set(id, at);
  }
  async publish(_event: RevocationEvent): Promise<void> {}
}

export const realAuth = (baseUrl: string, principals: PrincipalRecord[]) => {
  const pair = generateEs256KeyPair();
  const meta: SigningKeyMeta = {
    kid: pair.kid,
    purpose: 'as',
    alg: 'ES256',
    publicJwk: pair.publicJwk,
    activeFrom: new Date(Date.now() - 86_400_000),
    retireAfter: new Date(Date.now() + 30 * 86_400_000),
  };
  const keys: SigningKeySource = { listSigningKeys: async () => [meta] };
  const store: PrincipalStore = {
    getPrincipal: async (id) => principals.find((p) => p.id === id) ?? null,
  };
  const pats: PatRepository = {
    findByHash: async () => null,
    findById: async () => null,
    insert: async () => undefined,
    listByPrincipal: async () => [],
    markRevoked: async () => undefined,
    revokeAllForPrincipal: async () => [],
    touchLastUsed: async () => undefined,
  };
  const revocations = new MemoryRevocations();
  const verifier = new TokenVerifier({
    baseUrl,
    issuer: `${baseUrl}/oauth`,
    keys,
    principals: store,
    revocations,
    pats,
  });
  const sign = async (
    claims: Record<string, unknown> = {},
    options: {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      iat?: number;
      typ?: string;
      sub?: string;
    } = {},
  ): Promise<string> => {
    const key = await importJWK(pair.privateJwk, 'ES256');
    const iat = options.iat ?? Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: 'mcp', client_id: 'client-1', 'bastion:pt': 'user', ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: options.typ ?? 'at+jwt', kid: pair.kid })
      .setIssuer(options.iss ?? `${baseUrl}/oauth`)
      .setSubject(options.sub ?? principals[0]?.id ?? '')
      .setAudience(options.aud ?? `${baseUrl}/mcp`)
      .setIssuedAt(iat)
      .setExpirationTime(options.exp ?? iat + 900)
      .setJti('jti-1')
      .sign(key);
  };
  /** An unsigned token: header `{"alg":"none"}`. */
  const unsigned = (sub: string): string => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return `${b64({ alg: 'none', typ: 'at+jwt' })}.${b64({
      iss: `${baseUrl}/oauth`,
      sub,
      aud: `${baseUrl}/mcp`,
      scope: 'mcp',
      iat: now,
      exp: now + 900,
    })}.`;
  };
  return { verifier, sign, unsigned, revocations };
};
