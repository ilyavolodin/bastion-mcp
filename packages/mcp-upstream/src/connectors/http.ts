import { type PriorDiscovery, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type Logger, noopLogger } from '../ports';
import { UPSTREAM_TIMEOUTS_MS } from '../timeouts';
import { createUpstreamClient } from './client-factory';
import {
  connectClient,
  type OpenedRemote,
  openRemote,
  type RemoteConnectorOptions,
} from './connect';
import type { ConnectContext, UpstreamConnector, UpstreamSession } from './types';

/** Connect-time handshake limit; the transport itself has its own request timeouts. */
export const CONNECT_TIMEOUT_MS = UPSTREAM_TIMEOUTS_MS.remoteConnect;

export type { RemoteConnectorOptions };

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
    const remote = await openRemote(
      ctx,
      this.options,
      this.logger,
      'streamable-http',
      'HttpConnector',
    );
    if (ctx.remoteSession) {
      const attached = await this.tryResume(ctx, remote);
      if (attached) return attached;
    }
    const transport = new StreamableHTTPClientTransport(remote.url, { fetch: remote.fetch });
    const client = createUpstreamClient(installation, this.options.version, 'auto');
    await connectClient(client, transport, {
      signal: ctx.signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      prior: ctx.prior,
      violation: () => remote.caps.violation,
    });
    const era = client.getProtocolEra() ?? 'legacy';
    const verdict: PriorDiscovery =
      era === 'modern' && client.getDiscoverResult()
        ? { kind: 'modern', discover: client.getDiscoverResult() as never }
        : { kind: 'legacy' };
    ctx.onVerdict?.(verdict);
    return remote.session({
      client,
      transport,
      installation,
      era,
      continuations: ctx.continuations,
    });
  }

  /** Reattaches a stored legacy session id instead of `initialize` (21.2); null when the upstream dropped it. */
  private async tryResume(
    ctx: ConnectContext,
    remote: OpenedRemote,
  ): Promise<UpstreamSession | null> {
    const stored = ctx.remoteSession;
    if (!stored) return null;
    const transport = new StreamableHTTPClientTransport(remote.url, {
      fetch: remote.fetch,
      sessionId: stored.sessionId,
      protocolVersion: stored.protocolVersion,
    });
    const client = createUpstreamClient(ctx.installation, this.options.version, 'legacy');
    try {
      await connectClient(client, transport, {
        signal: ctx.signal,
        timeoutMs: CONNECT_TIMEOUT_MS,
        prior: { kind: 'legacy' },
      });
      const session = remote.session({
        client,
        transport,
        installation: ctx.installation,
        era: 'legacy',
        fallback: {
          protocolVersion: stored.protocolVersion,
          serverCapabilities: stored.serverCapabilities,
        },
        continuations: ctx.continuations,
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
        timeoutMs: UPSTREAM_TIMEOUTS_MS.resumePing,
      });
      await client.notification({ method: 'notifications/initialized' });
      return session;
    } catch (error) {
      this.logger.info('legacy remote session could not be resumed, starting fresh', {
        installation: ctx.installation.slug,
        error: String(error),
      });
      await client.close().catch(() => undefined);
      if (remote.caps.violation) throw remote.caps.violation;
      return null;
    }
  }
}
