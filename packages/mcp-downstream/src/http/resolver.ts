/** Endpoint resolution (4.4, 7.1, 7.2): slug to endpoint definition, effective endpoint from the per-worker cache. */
import type { Principal } from '@bastion-mcp/auth';
import {
  clockContext,
  type McpRequestContext,
} from '@bastion-mcp/policy';
import {
  compileEndpoint,
  type EffectiveEndpoint,
  type EndpointCache,
  type InstallationInfo,
  type ParsedEndpointPath,
  resolveEndpointDefinition,
  type UpstreamItemSource,
} from '@bastion-mcp/router';
import type { Clock, EndpointDataPort, Logger, PolicyPort, PrincipalProfilePort, ToPolicyPrincipal } from '../ports';
import type { ResolvedEndpoint } from '../types';

export type EndpointResolverDeps = {
  data: EndpointDataPort;
  cache: EndpointCache;
  source: UpstreamItemSource;
  policy: PolicyPort;
  toPolicyPrincipal: ToPolicyPrincipal;
  profiles?: PrincipalProfilePort | undefined;
  org: { displayName: string };
  serverVersion: string;
  clock: Clock;
  logger: Logger;
};

/** The cache key part of an endpoint: stable per path, known before the data is loaded. */
export const endpointKey = (parsed: ParsedEndpointPath): string =>
  parsed.kind === 'default' ? 'default' : `${parsed.kind}:${parsed.slug}`;

const NEGATIVE_TTL_MS = 5_000;
const NEGATIVE_MAX = 10_000;

export class EndpointResolver {
  private readonly resolved = new WeakMap<EffectiveEndpoint, ResolvedEndpoint>();
  private readonly negative = new Map<string, number>();

  constructor(private readonly deps: EndpointResolverDeps) {}

  /** `null` when the slug names nothing the principal can use (hidden is nonexistent, 6.9). */
  async resolve(
    principal: Principal,
    parsed: ParsedEndpointPath,
    request: { clientId: string; clientName: string; ip: string; authMethod: string; path: string },
  ): Promise<ResolvedEndpoint | null> {
    const key = endpointKey(parsed);
    const negativeKey = `${principal.id}\0${key}`;
    const until = this.negative.get(negativeKey);
    if (until !== undefined) {
      if (until > this.deps.clock.now()) return null;
      this.negative.delete(negativeKey);
    }
    const configVersion = await this.deps.data.configVersion();
    const cacheKey = { principalId: principal.id, endpointId: key, configVersion };
    let missing = false;
    const endpoint = await this.deps.cache.getOrCompile(cacheKey, async () => {
      const data = await this.deps.data.load(principal);
      const definition = resolveEndpointDefinition(parsed, {
        installations: data.installations,
        namedEndpoints: data.namedEndpoints,
      });
      if (!definition) {
        missing = true;
        throw new EndpointNotFound();
      }
      const profile = this.deps.profiles ? await this.deps.profiles.profile(principal) : {};
      const compiled = await compileEndpoint({
        principal: this.deps.toPolicyPrincipal(principal, profile),
        endpoint: definition,
        installations: data.installations,
        ...(data.hiddenInstallationIds ? { hiddenInstallationIds: data.hiddenInstallationIds } : {}),
        source: this.deps.source,
        policy: this.deps.policy.current(),
        requestContext: policyRequestContext(request, this.deps.clock.now()),
        org: this.deps.org,
        serverVersion: this.deps.serverVersion,
        configVersion,
      });
      this.resolved.set(compiled, {
        definition,
        endpoint: compiled,
        installations: new Map<string, InstallationInfo>(data.installations.map((i) => [i.id, i])),
      });
      return compiled;
    }).catch((error: unknown) => {
      if (error instanceof EndpointNotFound || missing) return undefined;
      throw error;
    });
    if (!endpoint) {
      this.remember(negativeKey);
      return null;
    }
    const entry = this.resolved.get(endpoint);
    if (!entry) {
      // Cached by someone else without our side data: recompile on the next request.
      this.deps.cache.invalidate({ scope: 'endpoint', id: endpoint.endpointId });
      return this.resolve(principal, parsed, request);
    }
    return entry;
  }

  private remember(negativeKey: string): void {
    if (this.negative.size >= NEGATIVE_MAX) this.negative.clear();
    this.negative.set(negativeKey, this.deps.clock.now() + NEGATIVE_TTL_MS);
  }
}

class EndpointNotFound extends Error {}

const policyRequestContext = (
  request: { clientId: string; clientName: string; ip: string; authMethod: string; path: string },
  nowMs: number,
): McpRequestContext => ({
  clientId: request.clientId,
  clientName: request.clientName,
  ip: request.ip.length >= 2 ? request.ip : '0.0.0.0',
  authMethod: request.authMethod,
  ...clockContext(new Date(nowMs)),
  endpoint: request.path,
});
