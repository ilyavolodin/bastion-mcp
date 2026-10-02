import type { MemoryStore } from '../memory-store';
import { W } from '../world';

/** Registry source, policy, an open install request, policy and limit rules, a guard profile (area C). */
export const seedRegistry = async (store: MemoryStore): Promise<void> => {
  await store.seed('registry_sources', {
    id: 'src-official',
    name: 'Official',
    baseUrl: 'https://registry.example.com',
    authSecretId: null,
    authHeaderName: null,
    trust: 'official',
    enabled: true,
    syncIntervalS: 3600,
    lastUpdatedSince: null,
    lastSync: null,
  });
  await store.seed('registry_policies', {
    id: 'src-official',
    policy: {
      allowedNamespaces: ['*'],
      blockedNamespaces: [],
      allowedRuntimes: ['remote', 'npm'],
      whoMayInstall: 'everyone',
      mode: 'direct',
      requireOsvClean: true,
      maxRisk: 'medium',
    },
  });
  await store.seed('install_requests', {
    id: 'req-1',
    requesterId: W.memberA,
    sourceId: 'src-official',
    serverName: 'io.github.acme/npm-tool',
    version: '2.1.0',
    justification: 'Need it for reports',
    status: 'open',
    decidedBy: null,
    decidedAt: null,
    reason: null,
    createdAt: '2026-06-01T10:00:00.000Z',
  });
  await store.seed('policy_rules', {
    id: 'rule-1',
    name: 'Deny destructive tools',
    ownerTeamId: null,
    effect: 'forbid',
    who: { role: 'member' },
    what: { annotations: { destructive: true } },
    when: {},
    enabled: true,
    priority: 100,
  });
  await store.seed('custom_policies', {
    id: 'cp-1',
    name: 'Example',
    cedar: 'forbid (principal, action, resource) when { false };',
    tests: [],
    enabled: false,
  });
  await store.seed('guard_profiles', {
    id: 'gp-1',
    name: 'Strict',
    isOrgDefault: false,
    latencyBudgetMs: 1500,
    guards: [{ instanceId: 'g1', type: 'regex', config: { patterns: [] } }],
  });
  await store.seed('limit_rules', {
    id: 'lr-1',
    name: 'Daily quota per user',
    subject: 'user',
    subjectMatch: 'each',
    scope: {},
    kind: 'quota',
    params: { points: 1000, period: 'day' },
    metric: 'calls',
    action: 'reject',
    enabled: true,
  });
  await store.seed('limit_rules', {
    id: 'lr-2',
    name: 'Org burst',
    subject: 'org',
    subjectMatch: 'each',
    scope: {},
    kind: 'rate',
    params: { points: 600, perSeconds: 60, burst: 100 },
    metric: 'calls',
    action: 'warn',
    enabled: true,
  });
};
