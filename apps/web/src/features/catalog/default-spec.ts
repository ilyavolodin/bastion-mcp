import type { SourceSpec } from '@/api/types';

export const defaultSpec = (): SourceSpec => ({
  runtime: 'npm',
  package: '',
  version: '0.1.0',
  command: 'npx',
  args: [],
  url: '',
  variables: [],
  authMode: 'none',
  oauthScopes: [],
  egressHosts: [],
  isolation: 'gvisor',
  guardProfileId: null,
  limitsProfile: 'default',
  onDrift: 'hideChanged',
  userOverrides: 'cosmetic',
  overrides: { version: 1 },
});
