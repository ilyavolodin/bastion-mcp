import type { MemoryStore } from '../memory-store';
import { W } from '../world';

const marketplace = (
  id: string,
  slug: string,
  ownerTeamId: string | null,
  audience: { org: boolean; teamIds: string[]; userIds: string[] },
) => ({
  id,
  slug,
  displayName: slug,
  ownerTeamId,
  audience,
  desktopInstallation: 'available',
  mirror: null,
  mirrorStatus: null,
  promotedRelease: null,
});

/** Rows of area D: credentials, IdP, SCIM, OAuth clients, marketplaces, settings (16.2). */
export const seedIdentity = async (store: MemoryStore): Promise<void> => {
  await store.update('service_accounts', W.svc, { oauthClientId: 'sa_seed' });
  await store.seed('service_account_clients', {
    id: 'sa_seed',
    serviceAccountId: W.svc,
    authMethod: 'client_secret_basic',
    secretSha256: 'seed-hash',
    jwks: null,
  });
  await store.seed('service_accounts', {
    id: 'svc-b',
    teamId: W.teamB,
    slug: 'deploy',
    displayName: 'Deploy',
    status: 'active',
  });
  await store.seed('idp_connections', {
    id: 'idp-1',
    name: 'Okta',
    issuer: 'https://idp.example.com',
    discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
    clientId: 'bastion',
    clientSecretId: 'secret-idp-1',
    scopes: ['openid', 'email'],
    claimMap: {},
    emailDomains: ['example.com'],
    enabled: true,
  });
  await store.seed('scim_tokens', {
    id: 'scim-1',
    name: 'Okta SCIM',
    tokenSha256: 'hash',
    createdBy: W.admin,
    expiresAt: null,
    revokedAt: null,
  });
  await store.seed('oauth_clients', { id: 'client-1', preApproved: false, blocked: false });
  await store.seed('catalog_entries', {
    id: 'entry-mkt-1',
    slug: 'plug',
    kind: 'plugin',
    displayName: 'Plug',
    visibility: { org: true, teamIds: [], userIds: [] },
    status: 'published',
    risk: 'low',
  });
  await store.seed(
    'marketplaces',
    marketplace('mkt-team-a', 'team-a-market', W.teamA, {
      org: false,
      teamIds: [W.teamA],
      userIds: [],
    }),
  );
  await store.seed(
    'marketplaces',
    marketplace('mkt-team-b', 'team-b-market', W.teamB, {
      org: false,
      teamIds: [W.teamB],
      userIds: [],
    }),
  );
  await store.seed(
    'marketplaces',
    marketplace('mkt-org', 'org-market', null, { org: true, teamIds: [], userIds: [] }),
  );
  await store.seed('marketplace_items', {
    id: 'mkt-team-a:entry-mkt-1',
    marketplaceId: 'mkt-team-a',
    catalogEntryId: 'entry-mkt-1',
    policy: 'available',
    pinnedVersionId: null,
    position: 0,
  });
  await store.seed('settings', { id: '_version', value: null });
};
