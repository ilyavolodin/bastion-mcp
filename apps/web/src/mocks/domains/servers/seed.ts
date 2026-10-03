/** Builds the seeded servers slice: installations, endpoints, egress decisions and the upstream definitions. */
import { toolPrefixFromSlug } from '@bastion-mcp/core/ids';
import { ME_ID, SEED_IDS } from '../../seed';
import { ITEMS } from '../../servers/definitions';
import { toUpstream } from '../../servers/overrides-engine';
import { DAY, HOUR, iso } from '../../util';
import { SEEDS } from './seed-data';
import type { Endpoint, Installation, ServersData } from './types';

const ME = ME_ID;

const secretRef = (installation: string, name: string, scope: 'user' | 'team') => ({
  scope,
  name: `${installation}.${name}`,
  version: 1,
});

export const buildServersData = (now: number): ServersData => {
  const created = iso(now - 20 * DAY);
  const installations: Installation[] = SEEDS.map((s) => {
    const team = s.owner.startsWith('t-');
    return {
      id: s.id,
      ownerType: team ? 'team' : 'user',
      ownerId: s.owner,
      catalogEntryId: `c-${s.entry}`,
      catalogVersionId: `v-${s.entry}-${s.version}`,
      pinnedVersion: false,
      personalSpec: null,
      slug: s.slug,
      toolPrefix: toolPrefixFromSlug(s.slug),
      displayName: s.name,
      enabled: s.status !== 'error',
      variables: s.variables ?? {},
      secretRefs: Object.fromEntries(
        (s.secrets ?? []).map((n) => [n, secretRef(s.id, n, team ? 'team' : 'user')]),
      ),
      overrides: s.overrides ?? {},
      origin: 'catalog',
      status: s.status,
      statusDetail: s.detail ? { code: 'start_failed', message: s.detail } : null,
      createdAt: created,
      updatedAt: iso(now - DAY),
    };
  });

  const endpoint = (
    id: string,
    slug: string,
    displayName: string,
    installationIds: string[],
    ageDays: number,
  ): Endpoint => ({
    id,
    ownerType: 'user',
    ownerId: ME,
    slug,
    displayName,
    installationIds,
    prefixMode: 'always',
    instructions: null,
    createdAt: iso(now - ageDays * DAY),
    updatedAt: iso(now - ageDays * DAY),
  });

  const egress: ServersData['egress'] = {
    [SEED_IDS.installation.postgres]: [
      { ts: iso(now - HOUR), host: 'warehouse.acme.internal', port: 5432, decision: 'allowed' },
      { ts: iso(now - 3 * HOUR), host: 'registry.npmjs.org', port: 443, decision: 'allowed' },
      { ts: iso(now - 2 * HOUR), host: 'telemetry.example.net', port: 443, decision: 'denied' },
    ],
    [SEED_IDS.installation.filesystem]: [
      { ts: iso(now - 5 * HOUR), host: 'registry.npmjs.org', port: 443, decision: 'allowed' },
    ],
    [SEED_IDS.installation.webFetch]: [
      { ts: iso(now - HOUR), host: 'en.wikipedia.org', port: 443, decision: 'allowed' },
      { ts: iso(now - 4 * HOUR), host: 'docs.acme.dev', port: 443, decision: 'allowed' },
    ],
  };

  return {
    installations,
    endpoints: [
      endpoint(
        'e-eng',
        'engineering',
        'Engineering',
        [SEED_IDS.installation.github, SEED_IDS.installation.jira, SEED_IDS.installation.linear],
        9,
      ),
      endpoint(
        'e-support',
        'support',
        'Support',
        [SEED_IDS.installation.zendesk, SEED_IDS.installation.jira],
        4,
      ),
    ],
    egress,
    upstream: Object.fromEntries(
      SEEDS.map((s) => [s.id, toUpstream(ITEMS[s.entry] ?? [])] as const),
    ),
  };
};
