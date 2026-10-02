import { SSEClientTransport } from '@modelcontextprotocol/client';
import { type Logger, noopLogger } from '../ports';
import { CapTracker } from './caps';
import { createUpstreamClient } from './client-factory';
import { CONNECT_TIMEOUT_MS, type RemoteConnectorOptions } from './http';
import { createRemoteFetch, resolveRemoteTarget } from './remote';
import { SdkUpstreamSession } from './session';
import type { ConnectContext, UpstreamConnector, UpstreamSession } from './types';

/** Deprecated HTTP+SSE upstream (6.1): SDK `SSEClientTransport`, always a legacy session with an owner (6.4). */
export class SseConnector implements UpstreamConnector {
  private readonly logger: Logger;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async connect(ctx: ConnectContext): Promise<UpstreamSession> {
    const { installation } = ctx;
    if (installation.spec.type !== 'remote' || installation.spec.transport !== 'sse') {
      throw new Error('SseConnector needs an sse remote spec');
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
    const transport = new SSEClientTransport(target.url, {
      fetch,
      eventSourceInit: { fetch } as never,
    });
    const client = createUpstreamClient(installation, this.options.version, 'legacy');
    try {
      await client.connect(transport, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw caps.violation ?? error;
    }
    ctx.onVerdict?.({ kind: 'legacy' });
    session = new SdkUpstreamSession({
      client,
      transport,
      installation,
      era: 'legacy',
      continuations: ctx.continuations,
      logger: this.logger,
      capViolation: () => caps.violation,
    });
    return session;
  }
}
