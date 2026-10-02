import { UpstreamUnavailableError } from '@bastion-mcp/core';
import { type PriorDiscovery, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type Logger, noopLogger } from '../ports';
import type { RemoteAgentRegistry } from './agent';
import { CapTracker } from './caps';
import { createUpstreamClient } from './client-factory';
import { createRemoteFetch, type RemoteSettings, resolveRemoteTarget } from './remote';
import { SdkUpstreamSession } from './session';
import type { ConnectContext, UpstreamConnector, UpstreamSession } from './types';

/** Connect-time handshake limit; the transport itself has its own request timeouts. */
export const CONNECT_TIMEOUT_MS = 15_000;

export type RemoteConnectorOptions = {
  agents: RemoteAgentRegistry;
  settings: RemoteSettings;
  /** Bastion version for `clientInfo.version` (6.4). */
  version: string;
  logger?: Logger;
  /** Overrides the 32 MiB / 100 MiB response caps (tests). */
  caps?: { messageBytes?: number; streamBytes?: number };
};

/**
 * Streamable HTTP upstream (6.4, 8.9): SDK `StreamableHTTPClientTransport` with `versionNegotiation: auto`, the
 * cached verdict passed back as `prior` so only the first connection per credential probes.
 */
export class HttpConnector implements UpstreamConnector {
  private readonly logger: Logger;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async connect(ctx: ConnectContext): Promise<UpstreamSession> {
    const { installation } = ctx;
    if (installation.spec.type !== 'remote' || installation.spec.transport !== 'streamable-http') {
      throw new Error('HttpConnector needs a streamable-http remote spec');
    }
    const target = await resolveRemoteTarget(
      installation,
      ctx.principal,
      ctx.credential,
      this.options.settings,
    );
    const agent = this.options.agents.get(installation.installationId, target.safe, target.tls);
    let session: SdkUpstreamSession | undefined;
    const caps = new CapTracker({
      ...this.options.caps,
      installation: installation.slug,
      logger: this.logger,
      onViolation: (error) => session?.abortAll(error),
    });
    const fetch = createRemoteFetch({ agent, headers: target.headers, caps });
    const resumed = ctx.remoteSession;
    if (resumed) {
      const attached = await this.tryResume(ctx, target.url, fetch, caps);
      if (attached) return attached;
    }
    const transport = new StreamableHTTPClientTransport(target.url, { fetch });
    const client = createUpstreamClient(installation, this.options.version, 'auto');
    try {
      await client.connect(transport, {
        ...(ctx.prior ? { prior: ctx.prior } : {}),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw caps.violation ?? error;
    }
    const era = client.getProtocolEra() ?? 'legacy';
    const verdict: PriorDiscovery =
      era === 'modern' && client.getDiscoverResult()
        ? { kind: 'modern', discover: client.getDiscoverResult() as never }
        : { kind: 'legacy' };
    ctx.onVerdict?.(verdict);
    session = new SdkUpstreamSession({
      client,
      transport,
      installation,
      era,
      continuations: ctx.continuations,
      logger: this.logger,
      capViolation: () => caps.violation,
    });
    return session;
  }

  /** Reattaches a stored legacy session id instead of `initialize` (21.2); null when the upstream dropped it. */
  private async tryResume(
    ctx: ConnectContext,
    url: URL,
    fetch: ReturnType<typeof createRemoteFetch>,
    caps: CapTracker,
  ): Promise<UpstreamSession | null> {
    const stored = ctx.remoteSession;
    if (!stored) return null;
    const transport = new StreamableHTTPClientTransport(url, {
      fetch,
      sessionId: stored.sessionId,
      protocolVersion: stored.protocolVersion,
    });
    const client = createUpstreamClient(ctx.installation, this.options.version, 'legacy');
    let session: SdkUpstreamSession | undefined;
    try {
      await client.connect(transport, {
        prior: { kind: 'legacy' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
      });
      session = new SdkUpstreamSession({
        client,
        transport,
        installation: ctx.installation,
        era: 'legacy',
        fallback: {
          protocolVersion: stored.protocolVersion,
          serverCapabilities: stored.serverCapabilities,
        },
        continuations: ctx.continuations,
        logger: this.logger,
        capViolation: () => caps.violation,
      });
      // Liveness check; also reopens the standalone GET stream of the session (21.2).
      await session.ping({
        ctx: {
          principal: ctx.principal,
          installationId: ctx.installation.installationId,
          era: 'legacy',
          clientCapabilities: {},
          trace: {},
        },
        timeoutMs: 10_000,
      });
      await client.notification({ method: 'notifications/initialized' });
      return session;
    } catch (error) {
      this.logger.info('legacy remote session could not be resumed, starting fresh', {
        installation: ctx.installation.slug,
        error: String(error),
      });
      await client.close().catch(() => undefined);
      if (caps.violation) throw caps.violation;
      return null;
    }
  }
}

export const unavailable = (
  slug: string,
  message: string,
  cause?: unknown,
): UpstreamUnavailableError => new UpstreamUnavailableError(message, { installation: slug }, cause);
