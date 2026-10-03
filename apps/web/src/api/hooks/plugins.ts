import { useQueries, useQuery } from '@tanstack/react-query';
import { api, fetchAll, LOOKUP_PAGES } from '../client';
import type { Schemas } from '../schema';
import {
  type ClientSetup,
  channelTotals,
  type MarketplaceView,
  toClientSetup,
  toMarketplaceView,
  toReleaseViews,
} from '../views/plugins';
import { keys, useApiMutation } from './base';
import { fetchTeamNames, orNoNames } from './lookups';
import { useViewer } from './session';

type RolloutClient = Schemas['RolloutConfig']['client'];

/** The clients the "Set up your clients" card shows (Claude Desktop pins a promoted release: see the rollout card). */
export const SETUP_CLIENTS: readonly RolloutClient[] = [
  'claude-code',
  'codex',
  'claude-ai',
  'chatgpt',
];

type EntryRef = Pick<Schemas['CatalogEntry'], 'id' | 'slug' | 'displayName' | 'description'>;

/** Plugin entries of the catalog by slug (the plugin name of a release). Names only: a failure leaves the slugs. */
const pluginEntries = async (signal: AbortSignal): Promise<Map<string, EntryRef>> => {
  try {
    const rows = await fetchAll('/catalog', { kind: 'plugin' }, LOOKUP_PAGES, signal);
    return new Map(rows.map((e) => [e.slug, e]));
  } catch {
    return new Map();
  }
};

/** Marketplaces with the plugins of their latest release (a release lists name, version and policy per plugin). */
export const useMarketplaces = () => {
  const viewer = useViewer();
  return useQuery({
    queryKey: [...keys.marketplaces, 'list', viewer?.orgRole],
    enabled: viewer !== undefined,
    queryFn: async ({ signal }): Promise<MarketplaceView[]> => {
      if (!viewer) return [];
      const [rows, entries, names] = await Promise.all([
        fetchAll('/marketplaces', undefined, LOOKUP_PAGES, signal),
        pluginEntries(signal),
        orNoNames(fetchTeamNames(signal)),
      ]);
      return Promise.all(
        rows.map(async (row) => {
          const releases = await api
            .get(`/marketplaces/${row.id}/releases`, { query: { limit: 1 }, signal })
            .catch(() => null);
          return toMarketplaceView(row, {
            teamNames: names,
            entries,
            latest: releases?.items[0] ?? null,
            me: viewer,
          });
        }),
      );
    },
  });
};

export const useMarketplace = (id: string | undefined) => {
  const viewer = useViewer();
  return useQuery({
    queryKey: [...keys.marketplaces, 'detail', id, viewer?.orgRole],
    enabled: Boolean(id) && viewer !== undefined,
    queryFn: async ({ signal }): Promise<MarketplaceView> => {
      const [row, releases, entries, names] = await Promise.all([
        api.get(`/marketplaces/${id}`, { signal }),
        api.get(`/marketplaces/${id}/releases`, { query: { limit: 1 }, signal }),
        pluginEntries(signal),
        orNoNames(fetchTeamNames(signal)),
      ]);
      return toMarketplaceView(row, {
        teamNames: names,
        entries,
        latest: releases.items[0] ?? null,
        me: viewer ?? { orgRole: 'member', teams: [] },
      });
    },
  });
};

/** Releases oldest first, with the one waiting for promotion marked. */
export const useReleases = (id: string) =>
  useQuery({
    queryKey: [...keys.marketplaces, 'releases', id],
    queryFn: async ({ signal }) => {
      const [page, row] = await Promise.all([
        api.get(`/marketplaces/${id}/releases`, { query: { limit: 100 }, signal }),
        api.get(`/marketplaces/${id}`, { signal }),
      ]);
      return toReleaseViews(page.items, row.promotedRelease);
    },
  });

export const useMirror = (id: string) =>
  useQuery({
    queryKey: [...keys.marketplaces, 'mirror', id],
    queryFn: ({ signal }) => api.get(`/marketplaces/${id}/mirror`, { signal }),
  });

/** Fetches of the marketplace's git repository per channel (25.9). */
export const useDistribution = (id: string) =>
  useQuery({
    queryKey: [...keys.marketplaces, 'usage', id],
    queryFn: async ({ signal }) =>
      channelTotals((await api.get(`/marketplaces/${id}/usage`, { signal })).buckets),
  });

export const usePromoteRelease = (id: string) =>
  useApiMutation(
    (n: number) => api.post(`/marketplaces/${id}/releases/${n}/promote`),
    [[...keys.marketplaces]],
  );

export const usePushMirror = (id: string) =>
  useApiMutation(() => api.post(`/marketplaces/${id}/mirror/push`), [[...keys.marketplaces]]);

export const useRollout = (id: string | undefined, client: RolloutClient) =>
  useQuery({
    queryKey: [...keys.marketplaces, 'rollout', id, client],
    enabled: Boolean(id),
    retry: false,
    queryFn: ({ signal }) => api.get(`/marketplaces/${id}/rollout`, { query: { client }, signal }),
  });

/** The set up panel of every client of a marketplace; a client whose configuration is not available is left out. */
export const useClientSetup = (id: string | undefined) => {
  const results = useQueries({
    queries: SETUP_CLIENTS.map((client) => ({
      queryKey: [...keys.marketplaces, 'rollout', id, client],
      enabled: Boolean(id),
      retry: false,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(`/marketplaces/${id}/rollout`, { query: { client }, signal }),
    })),
  });
  const setups: ClientSetup[] = results.flatMap((r) => (r.data ? [toClientSetup(r.data)] : []));
  return { setups, isPending: results.some((r) => r.isPending) };
};
