import { PROTOCOL_VERSIONS } from '@bastion-mcp/core';
import { Client, type ClientCapabilities } from '@modelcontextprotocol/client';
import type { ResolvedInstallation } from '../ports';
import { bastionClientInfo, declaredCapabilities } from './identity';

export type Negotiation = 'auto' | 'legacy' | 'modern';

/**
 * The SDK client of one upstream connection (6.4): Bastion identity, the capabilities it can bridge, and
 * `inputRequired.autoFulfill: false` everywhere so `input_required` comes back to Bastion (6.5).
 */
export const createUpstreamClient = (
  installation: Pick<ResolvedInstallation, 'enableSampling' | 'enableRoots'>,
  version: string,
  negotiation: Negotiation,
): Client =>
  new Client(bastionClientInfo(version), {
    capabilities: declaredCapabilities(installation) as ClientCapabilities,
    versionNegotiation:
      negotiation === 'auto'
        ? { mode: 'auto' }
        : negotiation === 'legacy'
          ? { mode: 'legacy' }
          : { mode: { pin: PROTOCOL_VERSIONS.modern[0] } },
    inputRequired: { autoFulfill: false },
    enforceStrictCapabilities: false,
  });
