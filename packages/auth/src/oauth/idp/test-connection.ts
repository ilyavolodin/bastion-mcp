import { z } from 'zod';
import type { FetchFn } from '../ports';
import { discoveryDocument } from './discovery';

export type ConnectionTestResult = {
  ok: boolean;
  issuer: string | null;
  jwksKeyCount: number | null;
  checks: { name: 'discovery' | 'issuer' | 'jwks'; ok: boolean; detail?: string }[];
};

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });

/** `idp_connection.test` for `POST /idp-connections/{id}/test` (17.2): discovery and JWKS reachability. */
export const testIdpConnection = async (input: {
  discoveryUrl: string;
  expectedIssuer: string;
  fetch: FetchFn;
}): Promise<ConnectionTestResult> => {
  const checks: ConnectionTestResult['checks'] = [];
  let issuer: string | null = null;
  let jwksUri: string | null = null;
  try {
    const doc = await discoveryDocument(input.discoveryUrl, input.fetch);
    issuer = doc.issuer;
    jwksUri = doc.jwks_uri;
    checks.push({ name: 'discovery', ok: true });
    const matches = doc.issuer === input.expectedIssuer;
    checks.push({
      name: 'issuer',
      ok: matches,
      ...(matches
        ? {}
        : {
            detail: `the discovery document says the issuer is ${doc.issuer}, but this connection has ${input.expectedIssuer}. They must match exactly (scheme, host, path and trailing slash): set the connection's Issuer to ${doc.issuer}`,
          }),
    });
  } catch (error) {
    checks.push({
      name: 'discovery',
      ok: false,
      detail: error instanceof Error ? error.message : 'failed',
    });
    return { ok: false, issuer, jwksKeyCount: null, checks };
  }
  let keyCount: number | null = null;
  try {
    const response = await input.fetch(jwksUri, { headers: { accept: 'application/json' } });
    if (response.status !== 200) throw new Error(`jwks returned ${response.status}`);
    keyCount = jwksSchema.parse(await response.json()).keys.length;
    checks.push({
      name: 'jwks',
      ok: keyCount > 0,
      ...(keyCount > 0 ? {} : { detail: 'JWKS has no keys' }),
    });
  } catch (error) {
    checks.push({
      name: 'jwks',
      ok: false,
      detail: error instanceof Error ? error.message : 'failed',
    });
  }
  return { ok: checks.every((c) => c.ok), issuer, jwksKeyCount: keyCount, checks };
};
