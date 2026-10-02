import type { ApiDeps, TryRequest } from '@bastion-mcp/api';
import { buildPrincipal, type Principal } from '@bastion-mcp/auth';
import { BastionError, effectiveTeamSlug, PROTOCOL_VERSIONS } from '@bastion-mcp/core';
import { createRouterRepository } from '@bastion-mcp/db';
import { EndpointResolver, type ResolvedEndpoint } from '@bastion-mcp/mcp-downstream';
import { type OverridesDocument, overridesSchema } from '@bastion-mcp/overrides';
import type { EndpointPolicy, InstallationInfo } from '@bastion-mcp/router';
import { SERVER_VERSION } from '../../config';
import type { AuthServices, PolicyService, WorkerServices } from '../../contracts';
import type { Infra } from '../../infra';
import { createInstallationLookup } from '../auth';
import { createEndpointData, createPrincipalProfiles } from '../downstream/endpoint-data';
import { connectAsPrincipal } from '../gateway-client';
import { readStderrTail } from '../upstream/stderr';
import { createUpstreamAccess, type UpstreamAccess } from '../upstream-access';

export class NoWorkerError extends BastionError {
  constructor(message = 'no worker is available to serve this request') {
    super('UPSTREAM_UNAVAILABLE', message, { httpStatus: 503 });
  }
}

export type InstallationPortsContext = {
  /** Present when this process hosts a worker (`BASTION_ROLE=all`). */
  worker?: WorkerServices | undefined;
  /** The Cedar engine service; the in-process "try" resolves the caller's endpoint with it. */
  policy: Pick<PolicyService, 'current'>;
  access?: UpstreamAccess | undefined;
};

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Cedar principal of the caller, like the downstream default (`defaultToPolicyPrincipal`). */
const toPolicyPrincipal = (principal: Principal, profile: { emailDomain?: string | undefined }) =>
  principal.type === 'service'
    ? {
        kind: 'service' as const,
        id: principal.id,
        active: principal.active,
        team: { id: principal.teams[0]?.teamId ?? '' },
      }
    : {
        kind: 'user' as const,
        id: principal.id,
        role: principal.orgRole,
        active: principal.active,
        emailDomain: profile.emailDomain ?? '',
        teams: principal.teams.map((t) => ({ id: t.teamId, role: t.role })),
      };

const INVALID_SPAN = { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };

/**
 * `ApiDeps['installations']` (11.4, 6.5, 9.6):
 * - `definitions`: the router's listing of an installation's upstream items (preview of the effective endpoint);
 * - `connect`: the per-user OAuth broker (`/connect/{id}` is the browser page, this is the API entry);
 * - `tryCall`: a call "as the caller" through the full pipeline (policy, overrides, guards, limits, call log). With a
 *   worker in the process it runs `downstream.run` with a synthesized request context. In a ui-only process it mints
 *   a 60 s access token for the caller with the authorization server's own signing key and calls the installation's
 *   public endpoint with the MCP client, so the worker applies exactly the same pipeline;
 * - `runtime`: restart, stderr tail (Redis stream `logs:{instanceId}`) and egress events (8.8).
 */
export const createInstallationApiPorts = (
  infra: Infra,
  auth: AuthServices,
  ctx: InstallationPortsContext,
): ApiDeps['installations'] => {
  const access = ctx.access ?? createUpstreamAccess(infra, auth, ctx.worker);
  const lookup = createInstallationLookup(infra);
  const router = createRouterRepository<OverridesDocument>(infra.db.prisma, {
    parseOverrides: (raw) => overridesSchema.parse(raw),
  });

  const principalOf = async (principalId: string): Promise<Principal> => {
    const record = await auth.principalStore.getPrincipal(principalId);
    if (!record?.active)
      throw new BastionError('POLICY_DENIED', 'the principal is not active', { httpStatus: 403 });
    return buildPrincipal(record, {
      authMethod: 'session',
      clientId: 'bastion-ui',
      scopes: ['mcp'],
    });
  };

  const infoOf = async (installationId: string, principal: Principal) => {
    const info = (await router.getInfo(installationId, {
      id: principal.id,
      type: principal.type,
      teamIds: principal.teams.map((t) => t.teamId),
    })) as unknown as InstallationInfo | null;
    if (!info) throw new BastionError('NOT_FOUND', 'installation not found', { httpStatus: 404 });
    const slug =
      info.owner.kind === 'team' ? effectiveTeamSlug(info.owner.slug, info.slug) : info.slug;
    return { info, slug };
  };

  // --- try: in-process -----------------------------------------------------------------------------------------------
  let resolver: EndpointResolver | undefined;
  const getResolver = (worker: WorkerServices): EndpointResolver => {
    resolver ??= new EndpointResolver({
      data: createEndpointData(infra),
      cache: worker.downstream.endpointCache,
      source: worker.runtime.lists,
      policy: { current: () => ctx.policy.current() as unknown as EndpointPolicy },
      toPolicyPrincipal,
      profiles: createPrincipalProfiles(infra),
      org: { displayName: 'Bastion' },
      serverVersion: SERVER_VERSION,
      clock: { now: () => Date.now() },
      logger: noopLogger,
    });
    return resolver;
  };

  const tryInProcess = async (
    worker: WorkerServices,
    input: Parameters<ApiDeps['installations']['tryCall']['run']>[0],
  ) => {
    const principal = await principalOf(input.principalId);
    const { slug } = await infoOf(input.installationId, principal);
    const path = `/mcp/i/${slug}`;
    const resolved: ResolvedEndpoint | null = await getResolver(worker).resolve(
      principal,
      { kind: 'installation', slug },
      {
        clientId: 'bastion-ui',
        clientName: 'Bastion try',
        ip: '127.0.0.1',
        authMethod: 'session',
        path,
      },
    );
    if (!resolved)
      throw new BastionError('NOT_FOUND', 'the installation is not available to this user', {
        httpStatus: 404,
      });
    const endpoint = resolved.endpoint;
    const nameOf = (
      routes: ReadonlyMap<string, { upstreamName: string }>,
      wanted: string,
    ): string => {
      if (routes.has(wanted)) return wanted;
      for (const [finalName, route] of routes) if (route.upstreamName === wanted) return finalName;
      return wanted;
    };
    const request = input.request;
    const method =
      request.kind === 'tool'
        ? 'tools/call'
        : request.kind === 'prompt'
          ? 'prompts/get'
          : 'resources/read';
    const params =
      request.kind === 'tool'
        ? { name: nameOf(endpoint.toolRoutes, request.name), arguments: request.arguments ?? {} }
        : request.kind === 'prompt'
          ? {
              name: nameOf(endpoint.promptRoutes, request.name),
              arguments: request.arguments ?? {},
            }
          : { uri: request.uri };
    const started = performance.now();
    let outcome: Awaited<ReturnType<WorkerServices['downstream']['run']>>;
    try {
      outcome = await worker.downstream.run(method, params, {
        principal,
        endpoint,
        era: 'modern',
        protocolVersion: PROTOCOL_VERSIONS.modern[0],
        clientCapabilities: {},
        clientInfo: { name: 'bastion-ui', version: SERVER_VERSION },
        trace: INVALID_SPAN,
        signal: input.signal ?? AbortSignal.timeout(60_000),
        emit: () => undefined,
        resolved,
        origin: 'client',
        ip: '127.0.0.1',
        authMethod: 'session',
        path,
      });
    } catch (error) {
      // Policy denials, guard blocks, limits and unknown names are legitimate results of a try (6.9).
      if (!(error instanceof BastionError)) throw error;
      return {
        result: {
          error: {
            code: error.code,
            message: error.message,
            mcpCode: error.mcpCode,
            data: error.data,
          },
        },
        isError: true,
        durationMs: Math.round(performance.now() - started),
        callId: null,
      };
    }
    const durationMs = Math.round(performance.now() - started);
    if (outcome.kind !== 'complete') {
      return {
        result: { error: 'the server asked for more input, which the try console cannot provide' },
        isError: true,
        durationMs,
        callId: null,
      };
    }
    const result = outcome.result as { isError?: unknown };
    return { result: outcome.result, isError: result?.isError === true, durationMs, callId: null };
  };

  // --- try: through the public endpoint (ui-only) ---------------------------------------------------------------------
  const tryOverHttp = async (input: Parameters<ApiDeps['installations']['tryCall']['run']>[0]) => {
    const principal = await principalOf(input.principalId);
    const { slug } = await infoOf(input.installationId, principal);
    const started = performance.now();
    let client: Awaited<ReturnType<typeof connectAsPrincipal>> | undefined;
    try {
      client = await connectAsPrincipal(infra, auth, principal.id, slug);
      const request: TryRequest = input.request;
      const result =
        request.kind === 'tool'
          ? await client.callTool({ name: request.name, arguments: request.arguments ?? {} })
          : request.kind === 'prompt'
            ? await client.getPrompt({ name: request.name, arguments: request.arguments ?? {} })
            : await client.readResource({ uri: request.uri });
      return {
        result,
        isError: (result as { isError?: unknown }).isError === true,
        durationMs: Math.round(performance.now() - started),
        callId: null,
      };
    } catch (error) {
      if (error instanceof BastionError) throw error;
      return {
        result: { error: error instanceof Error ? error.message : String(error) },
        isError: true,
        durationMs: Math.round(performance.now() - started),
        callId: null,
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
  };

  return {
    definitions: {
      async listItems(installationId, principalId, signal) {
        return access.listItems(installationId, principalId, signal);
      },
    },
    connect: {
      async begin({ installationId, principalId }) {
        const installation = await lookup.get(installationId);
        if (!installation) {
          throw new BastionError('NOT_FOUND', 'this installation does not use OAuth', {
            httpStatus: 404,
          });
        }
        return auth.broker.startAuthorization({ type: 'user', id: principalId }, installation);
      },
      async disconnect({ installationId, principalId }) {
        await auth.broker.disconnect(
          { type: 'user', id: principalId },
          await lookup.get(installationId),
          installationId,
        );
      },
    },
    tryCall: {
      run: (input) => (ctx.worker ? tryInProcess(ctx.worker, input) : tryOverHttp(input)),
    },
    runtime: {
      async restart(installationId) {
        await access.restart(installationId);
        await infra.repos.installations.clearError(installationId).catch(() => undefined);
      },
      async stop(installationId) {
        await access.stop(installationId);
      },
      async logTail(installationId, tail) {
        const record = await infra.repos.instances.getForInstallation(installationId);
        return record ? readStderrTail(infra, record.id, tail) : [];
      },
      async egress(installationId, limit) {
        const page = await infra.repos.egressEvents.list({ installationId, limit });
        return page.items.map((e) => ({
          ts: e.ts.toISOString(),
          host: e.host,
          port: e.port,
          decision: e.decision === 'allow' ? ('allowed' as const) : ('denied' as const),
          ...(e.bytesUp === null ? {} : { bytesOut: e.bytesUp }),
        }));
      },
    },
  };
};
