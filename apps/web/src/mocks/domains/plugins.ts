/**
 * MSW mock of the marketplace routes (marketplaces, releases, mirror, rollout configuration, usage), typed by the
 * generated OpenAPI types (see `../http.ts`). Rows are in the shape of the API; `buildPluginsData` seeds the Acme
 * marketplace and `pluginsHandlers` answer from `getDb().data.plugins`.
 */
import type { HttpHandler } from 'msw';
import type { Res, Schemas } from '@/api/schema';
import {
  etagHeaders,
  forbidden,
  HttpResponse,
  notFound,
  pageOf,
  problem,
  route,
  type Sample,
  type SampleFactory,
} from '../http';
import { isAdmin, managesTeam } from '../roles';
import { ME_ID, ORG_HOST } from '../seed';
import { getDb } from '../state';
import { DAY, HOUR, iso, nowIso, validationFailed } from '../util';

type Marketplace = Schemas['Marketplace'];
type Release = Schemas['MarketplaceRelease'];
type Rollout = Res<'get', '/marketplaces/{id}/rollout'>;
type Usage = Res<'get', '/marketplaces/{id}/usage'>['buckets'];

export type PluginsData = {
  marketplaces: Marketplace[];
  /** Releases by marketplace id, oldest first (the API lists them newest first). */
  releases: Record<string, Release[]>;
  usage: Record<string, Usage>;
};

export const MOCK_HOST = ORG_HOST;

const ITEMS: Release['items'] = [
  { name: 'release-notes', version: '1.4.0', policy: 'installedByDefault' },
  { name: 'incident-kit', version: '2.0.0', policy: 'available' },
  { name: 'data-helpers', version: '1.1.0', policy: 'available' },
  { name: 'api-style', version: '1.0.0', policy: 'available' },
  { name: 'test-writer', version: '0.8.0', policy: 'available' },
  { name: 'security-review', version: '1.0.0', policy: 'required' },
];

const release = (seq: number, at: number, commit: string, promoted: boolean): Release => ({
  seq,
  gitCommit: commit,
  releaseTime: iso(at),
  promoted,
  items: ITEMS,
  claudeManifestSha256: commit.padEnd(64, '0'),
  agentsManifestSha256: commit.padEnd(64, '1'),
  archives: {},
});

export const buildPluginsData = (now: number): PluginsData => ({
  marketplaces: [
    {
      id: 'mk-eng',
      slug: 'acme',
      displayName: 'Acme engineering',
      description: 'Skills, commands and tools for the engineering org',
      ownerTeamId: null,
      audience: { org: true, teamIds: [], userIds: [] },
      desktopInstallation: 'available',
      mirror: {
        provider: 'github',
        repo: 'acme/bastion-plugins',
        branch: 'main',
        credentialSecretId: 'github-mirror-token',
      },
      mirrorStatus: {
        status: 'ok',
        lastPushedSeq: 5,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: iso(now - 3 * HOUR),
      },
      promotedRelease: 5,
      createdBy: ME_ID,
      createdAt: iso(now - 90 * DAY),
      updatedAt: iso(now - HOUR),
    },
  ],
  releases: {
    'mk-eng': [
      release(1, now - 60 * DAY, 'a1f3c9e5d2b4a6c8e0f1a3b5c7d9e1f2a4b6c8d0', false),
      release(2, now - 45 * DAY, '7b2d1c0e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c', false),
      release(3, now - 30 * DAY, 'c93aa17b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c', false),
      release(4, now - 14 * DAY, 'e0192bd4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6', false),
      release(5, now - 10 * DAY, '58d0f4a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4', true),
      release(6, now - HOUR, '19ac33e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7', false),
    ],
  },
  usage: {
    'mk-eng': [
      { ts: iso(now - 2 * DAY), channel: 'git', action: 'fetch', count: 62 },
      { ts: iso(now - DAY), channel: 'git', action: 'fetch', count: 27 },
      { ts: iso(now - DAY), channel: 'mirror', action: 'push', count: 11 },
      { ts: iso(now - 3 * HOUR), channel: 'https', action: 'fetch', count: 8 },
    ],
  },
});

// --- handlers -----------------------------------------------------------------------------------------------------

const data = () => getDb().data.plugins;

/** Org-owned marketplaces are administered by admins, team-owned ones by that team's managers (10.1). */
const canWrite = (m: Marketplace): boolean =>
  isAdmin() || (m.ownerTeamId !== null && managesTeam(m.ownerTeamId));

const ROLLOUT_CLIENTS = [
  'claude-code',
  'claude-desktop-3p',
  'codex',
  'claude-ai',
  'chatgpt',
] as const;
type RolloutClient = (typeof ROLLOUT_CLIENTS)[number];
const isClient = (value: string | null): value is RolloutClient =>
  ROLLOUT_CLIENTS.some((c) => c === value);

const POLICY_LABEL = {
  required: 'Required',
  installedByDefault: 'Installed by default',
  available: 'Available',
} as const;

const rolloutFor = (m: Marketplace, client: RolloutClient, latest: Release): Rollout => {
  const url = `https://${MOCK_HOST}/plugins/${m.slug}.git`;
  const helper = '<path>/bastion-credential';
  const line = `git config --global credential.https://${MOCK_HOST}.helper "${helper}"`;
  switch (client) {
    case 'claude-code':
      return {
        client,
        managedSettings: {
          extraKnownMarketplaces: {
            [m.slug]: { source: { source: 'git', url }, autoUpdate: true },
          },
          enabledPlugins: Object.fromEntries(
            latest.items
              .filter((i) => i.policy === 'required')
              .map((i) => [`${i.name}@${m.slug}`, true as const]),
          ),
        },
        strictKnownMarketplacesEntry: { source: 'git', url },
        gitCredentialLine: line,
        installCommands: latest.items
          .filter((i) => i.policy === 'installedByDefault')
          .map((i) => `claude plugin install ${i.name}@${m.slug}`),
      };
    case 'claude-desktop-3p':
      return {
        client,
        allowedPluginMarketplaces: {
          gitEntry: {
            source: 'git',
            url,
            ref: latest.gitCommit,
            credentialKind: 'credentialHelper',
            credentialHelper: helper,
            installationPreference: m.desktopInstallation,
          },
        },
      };
    case 'codex':
      return {
        client,
        commands: [`codex plugin marketplace add ${url}`],
        gitCredentialLine: line,
        requirementsToml: [
          '[marketplaces]',
          'restrict_to_allowed_sources = true',
          '',
          `[marketplaces.allowed_sources.${m.slug}]`,
          'source = "git"',
          `url = "${url}"`,
        ].join('\n'),
      };
    case 'claude-ai':
    case 'chatgpt': {
      const where = m.mirror ? `https://github.com/${m.mirror.repo}` : null;
      return {
        client,
        steps: [
          where
            ? `Add ${where} under Organization settings > Plugins & skills > Marketplaces.`
            : 'Configure a mirror target for this marketplace first (GitHub or GitLab).',
          "Set each plugin's availability to the value listed below.",
        ],
        plugins: latest.items.map((i) => ({ name: i.name, setTo: POLICY_LABEL[i.policy] })),
      };
    }
  }
};

const newestFirst = (id: string): Release[] =>
  [...(data().releases[id] ?? [])].sort((a, b) => b.seq - a.seq);

const withPromoted = (m: Marketplace, r: Release): Release => ({
  ...r,
  promoted: m.promotedRelease === r.seq,
});

export const pluginsHandlers: HttpHandler[] = [
  route.get('/marketplaces', ({ url }) => HttpResponse.json(pageOf(data().marketplaces, url))),
  route.get('/marketplaces/{id}', ({ params }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    return HttpResponse.json(m, { headers: etagHeaders(m.updatedAt) });
  }),
  route.get('/marketplaces/{id}/releases', ({ params, url }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    return HttpResponse.json(
      pageOf(
        newestFirst(m.id).map((r) => withPromoted(m, r)),
        url,
      ),
    );
  }),
  route.post('/marketplaces/{id}/releases/{n}/promote', ({ params }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    if (!canWrite(m)) return forbidden();
    const r = data().releases[m.id]?.find((x) => x.seq === Number(params.n));
    if (!r) return notFound('Release');
    m.promotedRelease = r.seq;
    m.updatedAt = nowIso();
    return HttpResponse.json(withPromoted(m, r));
  }),
  route.get('/marketplaces/{id}/mirror', ({ params }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    return HttpResponse.json({ mirror: m.mirror, status: m.mirrorStatus, updatedAt: m.updatedAt });
  }),
  route.post('/marketplaces/{id}/mirror/push', ({ params }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    if (!canWrite(m)) return forbidden();
    if (!m.mirror)
      return problem(409, 'mirror_not_configured', 'Conflict', 'no mirror is configured');
    const state: Schemas['MirrorState'] = {
      status: 'ok',
      lastPushedSeq: newestFirst(m.id)[0]?.seq ?? null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: nowIso(),
    };
    m.mirrorStatus = state;
    return HttpResponse.json(state);
  }),
  route.get('/marketplaces/{id}/rollout', ({ params, url }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    const client = url.searchParams.get('client');
    if (!isClient(client)) {
      return validationFailed(
        [{ path: '/client', message: `use one of ${ROLLOUT_CLIENTS.join(', ')}` }],
        'unknown client',
      );
    }
    const latest =
      client === 'claude-desktop-3p' && m.promotedRelease !== null
        ? data().releases[m.id]?.find((r) => r.seq === m.promotedRelease)
        : newestFirst(m.id)[0];
    if (!latest) {
      return problem(409, 'no_release', 'Conflict', 'the marketplace has no release yet');
    }
    return HttpResponse.json(rolloutFor(m, client, latest));
  }),
  route.get('/marketplaces/{id}/usage', ({ params }) => {
    const m = data().marketplaces.find((x) => x.id === params.id);
    if (!m) return notFound('Marketplace');
    return HttpResponse.json({ buckets: data().usage[m.id] ?? [] });
  }),
];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const pluginsSamples: SampleFactory = (db) => {
  const id = db.data.plugins.marketplaces[0]?.id ?? '';
  const samples: Sample[] = [
    { method: 'get', path: '/marketplaces' },
    { method: 'get', path: `/marketplaces/${id}` },
    { method: 'get', path: `/marketplaces/${id}/releases` },
    { method: 'post', path: `/marketplaces/${id}/releases/6/promote` },
    { method: 'get', path: `/marketplaces/${id}/mirror` },
    { method: 'post', path: `/marketplaces/${id}/mirror/push` },
    ...ROLLOUT_CLIENTS.map(
      (client): Sample => ({ method: 'get', path: `/marketplaces/${id}/rollout?client=${client}` }),
    ),
    { method: 'get', path: `/marketplaces/${id}/usage` },
  ];
  return samples;
};
