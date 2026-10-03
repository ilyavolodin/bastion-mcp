import type { Client, PriorDiscovery, Transport } from '@modelcontextprotocol/client';
import type { Logger } from '../ports';
import type { RemoteAgentRegistry } from './agent';
import { CapTracker } from './caps';
import { createRemoteFetch, type RemoteSettings, resolveRemoteTarget } from './remote';
import { SdkUpstreamSession } from './session';
import type { ConnectContext } from './types';

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
 * Connects an SDK client within `timeoutMs`, also giving up when `signal` aborts. A failed handshake closes the
 * client; `violation` (a response cap that was exceeded) wins over the transport's own error (6.9).
 */
export const connectClient = async (
  client: Client,
  transport: Transport,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    prior?: PriorDiscovery | undefined;
    violation?: (() => Error | undefined) | undefined;
  },
): Promise<void> => {
  try {
    await client.connect(transport, {
      ...(options.prior ? { prior: options.prior } : {}),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      timeout: options.timeoutMs,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw options.violation?.() ?? error;
  }
};

/** What an HTTP or SSE connector needs before it picks a transport: SSRF-checked target, pinned agent, caps, fetch. */
export type OpenedRemote = {
  url: URL;
  fetch: ReturnType<typeof createRemoteFetch>;
  caps: CapTracker;
  /** Builds the session and lets the cap tracker abort it on a violation. */
  session: (
    init: Omit<ConstructorParameters<typeof SdkUpstreamSession>[0], 'capViolation' | 'logger'>,
  ) => SdkUpstreamSession;
};

export const openRemote = async (
  ctx: ConnectContext,
  options: RemoteConnectorOptions,
  logger: Logger,
  transport: 'streamable-http' | 'sse',
  connectorName: string,
): Promise<OpenedRemote> => {
  const { installation } = ctx;
  if (installation.spec.type !== 'remote' || installation.spec.transport !== transport) {
    throw new Error(
      `${connectorName} needs ${transport === 'sse' ? 'an' : 'a'} ${transport} remote spec`,
    );
  }
  const target = await resolveRemoteTarget(
    installation,
    ctx.principal,
    ctx.credential,
    options.settings,
  );
  const agent = options.agents.get(installation.installationId, target.safe, target.tls);
  let session: SdkUpstreamSession | undefined;
  const caps = new CapTracker({
    ...options.caps,
    installation: installation.slug,
    logger,
    onViolation: (error) => session?.abortAll(error),
  });
  const fetch = createRemoteFetch({ agent, headers: target.headers, caps });
  return {
    url: target.url,
    fetch,
    caps,
    session: (init) => {
      session = new SdkUpstreamSession({
        ...init,
        logger,
        capViolation: () => caps.violation,
      });
      return session;
    },
  };
};
