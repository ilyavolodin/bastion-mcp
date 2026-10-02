import { useQuery } from '@tanstack/react-query';
import { legacyApi as api } from '../client';
import type { Marketplace, MarketplaceDetail, RolloutConfig } from '../types';
import { keys, listQuery, useApiMutation } from './base';

export const useMarketplaces = () =>
  useQuery(listQuery<Marketplace>(keys.marketplaces, '/marketplaces'));

export const useMarketplace = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.marketplaces, 'detail', id],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get<MarketplaceDetail>(`/marketplaces/${id}`, { signal }),
  });

export const usePromoteRelease = (id: string) =>
  useApiMutation(
    (n: number) => api.post<void>(`/marketplaces/${id}/releases/${n}/promote`),
    [keys.marketplaces],
  );

export const usePushMirror = (id: string) =>
  useApiMutation(() => api.post<void>(`/marketplaces/${id}/mirror/push`), [keys.marketplaces]);

export const useRollout = (id: string | undefined, client: string) =>
  useQuery({
    queryKey: [...keys.marketplaces, 'rollout', id, client],
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<RolloutConfig>(`/marketplaces/${id}/rollout`, { query: { client }, signal }),
  });
