import { SandboxStdioTransport } from '@bastion-mcp/sandbox';
import { type Logger, noopLogger } from '../ports';
import { type Negotiation, createUpstreamClient } from './client-factory';
import { SdkUpstreamSession } from './session';
import type { CloseInfo, ConnectContext, UpstreamConnector, UpstreamSession } from './types';

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Sandboxed stdio upstream (6.4, 8.3): the SDK `Client` over `SandboxStdioTransport`. The era comes from the catalog
 * entry's `protocol` field (`legacy` by default) because some stdio servers exit on a pre-`initialize` request.
 */
export class SandboxConnector implements UpstreamConnector {
  private readonly logger: Logger;

  constructor(private readonly options: { version: string; logger?: Logger }) {
    this.logger = options.logger ?? noopLogger;
  }

  async connect(ctx: ConnectContext): Promise<UpstreamSession> {
    const { installation } = ctx;
    if (installation.spec.type !== 'package') throw new Error('SandboxConnector needs a package spec');
    const sandbox = ctx.sandbox;
    if (!sandbox) throw new Error('SandboxConnector needs the runner channel');
    const transport = new SandboxStdioTransport(sandbox.channel, {
      ...(sandbox.onStderr ? { onStderr: sandbox.onStderr } : {}),
    });
    const protocol = installation.spec.protocol;
    const negotiation: Negotiation =
      protocol === 'modern' ? 'modern' : protocol === 'auto' ? 'auto' : 'legacy';
    const client = createUpstreamClient(installation, this.options.version, negotiation);
    try {
      await client.connect(transport as never, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    const era = client.getProtocolEra() ?? 'legacy';
    return new SdkUpstreamSession({
      client,
      transport: transport as never,
      installation,
      era,
      continuations: ctx.continuations,
      logger: this.logger,
      describeClose: (): CloseInfo => ({
        exit: transport.exit,
        closeCode: transport.closeCode,
      }),
    });
  }
}
