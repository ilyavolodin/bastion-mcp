import { SSEClientTransport } from '@modelcontextprotocol/client';
import { type Logger, noopLogger } from '../ports';
import { createUpstreamClient } from './client-factory';
import { connectClient, openRemote, type RemoteConnectorOptions } from './connect';
import { CONNECT_TIMEOUT_MS } from './http';
import type { ConnectContext, UpstreamConnector, UpstreamSession } from './types';

/** Deprecated HTTP+SSE upstream (6.1): SDK `SSEClientTransport`, always a legacy session with an owner (6.4). */
export class SseConnector implements UpstreamConnector {
  private readonly logger: Logger;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async connect(ctx: ConnectContext): Promise<UpstreamSession> {
    const { installation } = ctx;
    const remote = await openRemote(ctx, this.options, this.logger, 'sse', 'SseConnector');
    const transport = new SSEClientTransport(remote.url, {
      fetch: remote.fetch,
      eventSourceInit: { fetch: remote.fetch } as never,
    });
    const client = createUpstreamClient(installation, this.options.version, 'legacy');
    await connectClient(client, transport, {
      signal: ctx.signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      violation: () => remote.caps.violation,
    });
    ctx.onVerdict?.({ kind: 'legacy' });
    return remote.session({
      client,
      transport,
      installation,
      era: 'legacy',
      continuations: ctx.continuations,
    });
  }
}
