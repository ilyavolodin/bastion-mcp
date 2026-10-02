import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import { ACCESS_TOKEN_TTL_S } from './constants';
import { issuerFor, mcpResource } from './urls';

/**
 * Test helper (not re-exported by the package index): mints an access token shaped like the ones the
 * embedded authorization server issues (RFC 9068, ES256, `bastion:pt`), for token-verification tests.
 */
export const mintTestAccessToken = async (input: {
  privateJwk: Record<string, string>;
  host: string;
  sub: string;
  scope?: string;
  resource?: string;
  clientId?: string;
  principalType?: 'user' | 'service';
  /** Epoch seconds; defaults to now. */
  iat?: number;
  expiresInSeconds?: number;
  issuer?: string;
  typ?: string;
}): Promise<string> => {
  const key = await importJWK(input.privateJwk, 'ES256');
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT({
    scope: input.scope ?? 'mcp',
    client_id: input.clientId ?? 'test-client',
    'bastion:pt': input.principalType ?? 'user',
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: input.typ ?? 'at+jwt',
      kid: input.privateJwk.kid ?? '',
    })
    .setIssuer(input.issuer ?? issuerFor(input.host))
    .setSubject(input.sub)
    .setAudience(input.resource ?? mcpResource(input.host))
    .setJti(randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + (input.expiresInSeconds ?? ACCESS_TOKEN_TTL_S))
    .sign(key);
};
