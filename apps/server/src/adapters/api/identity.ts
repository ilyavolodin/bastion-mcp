/**
 * `IdentityPorts` of the control-plane API: the IdP connection test fetches the discovery document and the JWKS
 * through the SSRF-guarded fetch and compares the issuer (9.1). `allowInsecureHttp` (tests, admin-allowed internal
 * IdPs) uses the plain fetch so loopback IdPs work.
 */
import type { IdentityPorts, IdpTestResult } from '@bastion-mcp/api';
import { createSafeFetch, type FetchFn, testIdpConnection } from '@bastion-mcp/auth';
import type { Infra } from '../../infra';

export const createIdentityPorts = (infra: Pick<Infra, 'options'>): IdentityPorts => {
  const base: FetchFn = infra.options.fetch ?? fetch;
  const fetchFn: FetchFn = infra.options.allowInsecureHttp ? base : createSafeFetch(base, {});
  return {
    async testIdp(input, signal): Promise<IdpTestResult> {
      const guarded: FetchFn = (url, init) =>
        fetchFn(url, { ...(init ?? {}), ...(signal ? { signal } : {}) });
      const result = await testIdpConnection({
        discoveryUrl: input.discoveryUrl,
        expectedIssuer: input.issuer,
        fetch: guarded,
      });
      const failed = result.checks.find((c) => !c.ok);
      return {
        ok: result.ok,
        ...(result.issuer === null ? {} : { issuer: result.issuer }),
        ...(result.issuer === null
          ? {}
          : { issuerMatches: result.checks.find((c) => c.name === 'issuer')?.ok === true }),
        ...(failed ? { error: `${failed.name}: ${failed.detail ?? 'failed'}` } : {}),
      };
    },
  };
};
