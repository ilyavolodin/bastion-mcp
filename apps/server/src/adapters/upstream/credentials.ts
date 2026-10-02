import { resolveTemplate } from '@bastion-mcp/core';
import type { UpstreamCredentialProvider } from '@bastion-mcp/mcp-upstream';
import type { AuthServices } from '../../contracts';

/**
 * Adapts auth's `UpstreamCredentialResolver` (9.5) to mcp-upstream's `UpstreamCredentialProvider`. Errors pass through
 * unchanged: both packages raise `BastionError` subclasses (`UpstreamAuthRequiredError` -32015 carries the connect
 * URL), which the upstream layer returns as is (6.9).
 */
export const createCredentialProvider = (
  auth: Pick<AuthServices, 'credentials'>,
): UpstreamCredentialProvider => ({
  async resolve(principal, installation, spec) {
    const upstreamUrl =
      spec.type === 'remote'
        ? resolveTemplate(spec.url, { var: installation.variables })
        : undefined;
    const resolved = await auth.credentials.resolve(
      { type: principal.type ?? 'user', id: principal.userId },
      {
        id: installation.installationId,
        name: installation.slug,
        ...(upstreamUrl ? { upstreamUrl } : {}),
        templateContext: {
          var: installation.variables,
          user: {
            id: principal.userId,
            ...(principal.email ? { email: principal.email } : {}),
            ...(principal.teams ? { teams: principal.teams } : {}),
          },
        },
      },
      spec,
    );
    return { injections: resolved.injections, credentialHash: resolved.credentialHash };
  },
});
