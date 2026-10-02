import { type ServerSpec, parseServerSpec } from '@bastion-mcp/core';
import type {
  CallPrincipal,
  ResolvedCredential,
  ResolvedInstallation,
} from '../../src/ports';
import type { UpstreamCallContext } from '../../src/types';

export const principal: CallPrincipal = {
  userId: 'user-1',
  clientName: 'claude-desktop',
  email: 'ada@example.com',
  teams: ['eng'],
};

export const remoteSpec = (
  url: string,
  transport: 'streamable-http' | 'sse' = 'streamable-http',
  extra: Record<string, unknown> = {},
): ServerSpec =>
  parseServerSpec({ type: 'remote', transport, url, auth: { mode: 'none' }, ...extra });

export const packageSpec = (extra: Record<string, unknown> = {}): ServerSpec =>
  parseServerSpec({
    type: 'package',
    runtime: 'npm',
    identifier: 'fake-stdio',
    version: '1.0.0',
    auth: { mode: 'none' },
    ...extra,
  });

export const installationOf = (
  spec: ServerSpec,
  overrides: Partial<ResolvedInstallation> = {},
): ResolvedInstallation => ({
  installationId: 'inst-1',
  slug: 'fake',
  catalogEntryId: 'entry-1',
  catalogVersionId: 'ver-1',
  catalogEntryName: 'fake-entry',
  origin: 'admin',
  ownerUserId: principal.userId,
  spec,
  variables: {},
  configHash: 'cfg-1',
  enableSampling: false,
  enableRoots: false,
  roots: [],
  extensions: {},
  replicas: 1,
  ...overrides,
});

export const credential: ResolvedCredential = { injections: [], credentialHash: 'cred-1' };

export const FULL_CAPS = {
  elicitation: { form: {}, url: {} },
  sampling: {},
  roots: {},
};

export const ctxOf = (overrides: Partial<UpstreamCallContext> = {}): UpstreamCallContext => ({
  principal,
  installationId: 'inst-1',
  era: 'modern',
  clientCapabilities: FULL_CAPS,
  trace: {},
  ...overrides,
});

export const LOOPBACK_SETTINGS = {
  privateCidrs: ['127.0.0.0/8'],
  insecureHosts: ['127.0.0.1'],
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
