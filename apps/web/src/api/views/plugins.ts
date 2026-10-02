/**
 * What the Plugins screens show, built from the rows of the API. A marketplace row has no plugin list, no owner name
 * and no per-client status: the plugins of a marketplace are the `items` of its latest release (name, version,
 * policy), joined here with the catalog entries of kind `plugin` for the display name and description; the owner is a
 * team name or the org; "can manage" follows the Cedar rules (org-owned: admins; team-owned: its managers).
 * Everything else is the generated schema type.
 */
import { letterOf, tintOf } from '@/lib/avatar';
import type { Res, Schemas } from '../schema';

export type Marketplace = Schemas['Marketplace'];
export type MarketplaceRelease = Schemas['MarketplaceRelease'];
export type MirrorState = Schemas['MirrorState'];
export type MirrorView = Res<'get', '/marketplaces/{id}/mirror'>;
export type RolloutConfig = Schemas['RolloutConfig'];
export type UsageBuckets = Res<'get', '/marketplaces/{id}/usage'>['buckets'];
export type ItemPolicy = Schemas['MarketplaceItem']['policy'];

export type PluginView = {
  /** The plugin name of the release: the catalog slug. */
  slug: string;
  version: string;
  policy: ItemPolicy;
  /** The catalog entry the plugin comes from, when the caller can read it. */
  entryId: string | null;
  name: string;
  description: string;
  letter: string;
  color: string;
};

export type MarketplaceView = Marketplace & {
  /** `displayName` of the row. */
  name: string;
  /** Team name of the owner, or `Org`. */
  owner: string;
  ownedByTeam: boolean;
  canManage: boolean;
  /** The plugins of the latest release. */
  plugins: PluginView[];
};

type EntryRef = Pick<Schemas['CatalogEntry'], 'id' | 'slug' | 'displayName' | 'description'>;
type MeRef = { orgRole: string; teams: { id: string; role: string }[] };

export const canManageMarketplace = (row: Pick<Marketplace, 'ownerTeamId'>, me: MeRef): boolean => {
  if (me.orgRole === 'admin') return true;
  return (
    row.ownerTeamId !== null &&
    me.teams.some((t) => t.id === row.ownerTeamId && t.role === 'manager')
  );
};

export const toPluginViews = (
  release: Pick<MarketplaceRelease, 'items'> | null,
  entries: ReadonlyMap<string, EntryRef>,
): PluginView[] =>
  (release?.items ?? []).map((item) => {
    const entry = entries.get(item.name);
    const name = entry?.displayName ?? item.name;
    return {
      slug: item.name,
      version: item.version,
      policy: item.policy,
      entryId: entry?.id ?? null,
      name,
      description: entry?.description ?? '',
      letter: letterOf(name),
      color: tintOf(item.name),
    };
  });

export const toMarketplaceView = (
  row: Marketplace,
  ctx: {
    teamNames: ReadonlyMap<string, string>;
    entries: ReadonlyMap<string, EntryRef>;
    latest: MarketplaceRelease | null;
    me: MeRef;
  },
): MarketplaceView => ({
  ...row,
  name: row.displayName,
  owner: row.ownerTeamId ? (ctx.teamNames.get(row.ownerTeamId) ?? 'Team') : 'Org',
  ownedByTeam: row.ownerTeamId !== null,
  canManage: canManageMarketplace(row, ctx.me),
  plugins: toPluginViews(ctx.latest, ctx.entries),
});

// --- releases ---------------------------------------------------------------------------------------------------

export type ReleaseView = MarketplaceRelease & {
  /** The newest release when it is not the promoted one and is newer than it: a candidate for promotion. */
  draft: boolean;
};

/** Releases oldest first (the timeline order), with the one waiting for promotion marked. */
export const toReleaseViews = (
  releases: readonly MarketplaceRelease[],
  promoted: number | null,
): ReleaseView[] => {
  const ascending = [...releases].sort((a, b) => a.seq - b.seq);
  const newest = ascending.at(-1)?.seq;
  return ascending.map((r) => ({
    ...r,
    draft: r.seq === newest && !r.promoted && (promoted === null || r.seq > promoted),
  }));
};

// --- distribution -----------------------------------------------------------------------------------------------

export const CHANNEL_LABEL: Record<string, string> = {
  git: 'Git clients',
  https: 'HTTPS manifest',
  mirror: 'Mirror',
};

export type ChannelTotal = { channel: string; label: string; count: number };

/** Fetches per channel, from the usage buckets (25.9). */
export const channelTotals = (buckets: UsageBuckets): ChannelTotal[] => {
  const totals = new Map<string, number>();
  for (const b of buckets) totals.set(b.channel, (totals.get(b.channel) ?? 0) + b.count);
  return [...totals.entries()]
    .map(([channel, count]) => ({ channel, label: CHANNEL_LABEL[channel] ?? channel, count }))
    .sort((a, b) => b.count - a.count);
};

// --- mirror -----------------------------------------------------------------------------------------------------

export type MirrorTone = 'ok' | 'warn' | 'bad' | 'neutral';

export const mirrorSummary = (
  view: MirrorView | undefined,
): { label: string; target: string | null; tone: MirrorTone; needsPush: boolean } => {
  const target = view?.mirror
    ? `${view.mirror.provider === 'github' ? 'github.com' : 'gitlab.com'}/${view.mirror.repo}`
    : null;
  if (!view?.mirror)
    return { label: 'No mirror configured', target, tone: 'neutral', needsPush: false };
  switch (view.status?.status) {
    case 'ok':
      return { label: 'in sync', target, tone: 'ok', needsPush: false };
    case 'retrying':
      return { label: 'retrying', target, tone: 'warn', needsPush: true };
    case 'diverged':
      return { label: 'diverged', target, tone: 'bad', needsPush: true };
    default:
      return { label: 'not pushed yet', target, tone: 'neutral', needsPush: true };
  }
};

// --- client set up ----------------------------------------------------------------------------------------------

export type ClientSetup = {
  client: RolloutConfig['client'];
  label: string;
  /** What to run, when the client has a command; the others follow `note`. */
  command: string | null;
  note: string;
};

export const CLIENT_LABEL: Record<RolloutConfig['client'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  'claude-desktop-3p': 'Claude Desktop (3P)',
  'claude-ai': 'claude.ai',
  chatgpt: 'ChatGPT',
};

/** The set up panel of one client, read off its rollout configuration (25.7). */
export const toClientSetup = (config: RolloutConfig): ClientSetup => {
  const label = CLIENT_LABEL[config.client];
  switch (config.client) {
    case 'claude-code':
      return {
        client: config.client,
        label,
        command: config.strictKnownMarketplacesEntry
          ? `/plugin marketplace add ${config.strictKnownMarketplacesEntry.url}`
          : null,
        note: 'Then sign in once with the bastion-credential helper.',
      };
    case 'codex':
      return {
        client: config.client,
        label,
        command: config.commands?.[0] ?? null,
        note: 'Then sign in once with the bastion-credential helper.',
      };
    default:
      return {
        client: config.client,
        label,
        command: null,
        note: config.steps?.[0] ?? 'Your admin configures this client.',
      };
  }
};

/** A rollout configuration as copyable text: JSON for settings, lines for commands and steps. */
export const rolloutText = (
  config: RolloutConfig,
): { kind: 'snippet' | 'checklist'; text: string } => {
  switch (config.client) {
    case 'claude-code':
      return {
        kind: 'snippet',
        text: JSON.stringify(
          {
            managedSettings: config.managedSettings,
            strictKnownMarketplaces: [config.strictKnownMarketplacesEntry],
          },
          null,
          2,
        ),
      };
    case 'claude-desktop-3p':
      return {
        kind: 'snippet',
        text: JSON.stringify(
          { allowedPluginMarketplaces: config.allowedPluginMarketplaces },
          null,
          2,
        ),
      };
    case 'codex':
      return {
        kind: 'snippet',
        text: [...(config.commands ?? []), '', config.requirementsToml ?? ''].join('\n').trim(),
      };
    default:
      return {
        kind: 'checklist',
        text: [
          ...(config.steps ?? []).map((s, i) => `${i + 1}. ${s}`),
          '',
          ...(config.plugins ?? []).map((p) => `${p.name}: ${p.setTo}`),
        ]
          .join('\n')
          .trim(),
      };
  }
};
