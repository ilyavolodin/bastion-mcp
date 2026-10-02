export type IdpTestResult = {
  ok: boolean;
  /** Issuer the discovery document declared; must equal the configured one. */
  issuer?: string;
  issuerMatches?: boolean;
  endpoints?: { authorization?: string; token?: string; jwks?: string };
  error?: string;
};

/** Fetches and checks an IdP discovery document (`POST /idp-connections/{id}/test`, 9.1). */
export interface IdentityPorts {
  testIdp(
    input: { issuer: string; discoveryUrl: string },
    signal?: AbortSignal,
  ): Promise<IdpTestResult>;
}
