import { z } from 'zod';
import type { FetchFn } from '../ports';

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().optional(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
});
export type OidcDiscovery = z.infer<typeof discoverySchema>;

export const wellKnownUrl = (discoveryUrl: string): string =>
  /\/\.well-known\/openid-configuration\/?$/.test(discoveryUrl)
    ? discoveryUrl
    : `${discoveryUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;

/** Reads and validates an OIDC discovery document through the (SSRF-guarded) fetch. */
export const discoveryDocument = async (
  discoveryUrl: string,
  fetchFn: FetchFn,
): Promise<OidcDiscovery> => {
  const response = await fetchFn(wellKnownUrl(discoveryUrl), {
    headers: { accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`discovery returned ${response.status}`);
  return discoverySchema.parse(await response.json());
};
