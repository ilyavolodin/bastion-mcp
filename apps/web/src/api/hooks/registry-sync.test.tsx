import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_SYNC_TIMEOUT_MS } from '../timing';
import type { SyncRequests } from '../views/registry';
import { keys } from './base';
import { useIsSyncing, useMarkSyncRequested, useSyncRequests } from './registry';

const NOW = Date.parse('2026-10-03T10:00:00.000Z');

const finished = (at: number) => ({
  startedAt: new Date(at).toISOString(),
  finishedAt: new Date(at).toISOString(),
  ok: true,
  full: false,
  pages: 1,
  fetched: 1,
  upserted: 1,
  invalid: 0,
  deleted: 0,
  deprecated: 0,
});

type Src = { id: string; lastSync: unknown };

const setup = (initial: Src[]) => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({ sources }: { sources: Src[] }) => ({
      isSyncing: useIsSyncing(sources as never),
      mark: useMarkSyncRequested(),
      requests: useSyncRequests(),
    }),
    { wrapper, initialProps: { sources: initial } },
  );
  return { client, ...view };
};

/** The query cache tells its observers on a timer: let it run. */
const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('sync requests live in the query cache (15.6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('starts with no request and no source syncing', async () => {
    const { result } = setup([{ id: 'a', lastSync: null }]);
    expect(result.current.requests.size).toBe(0);
    expect(result.current.isSyncing({ id: 'a', lastSync: null })).toBe(false);
  });

  it('marks a source as syncing from the click, and stops when the source reports a newer result', async () => {
    const a = { id: 'a', lastSync: null as unknown };
    const { result, rerender } = setup([a]);
    act(() => result.current.mark('a'));
    await flush();
    expect(result.current.requests.get('a')).toBe(NOW);
    expect(result.current.isSyncing(a)).toBe(true);

    const done = { id: 'a', lastSync: finished(NOW + 60_000) };
    vi.setSystemTime(NOW + 61_000);
    rerender({ sources: [done] });
    await flush();
    expect(result.current.isSyncing(done)).toBe(false);
    // The request that is over is forgotten.
    expect(result.current.requests.size).toBe(0);
  });

  it('gives up after the timeout and forgets the request', async () => {
    const a = { id: 'a', lastSync: null as unknown };
    const { result } = setup([a]);
    act(() => result.current.mark('a'));
    await flush();
    expect(result.current.isSyncing(a)).toBe(true);
    await flush(REGISTRY_SYNC_TIMEOUT_MS + 5);
    expect(result.current.isSyncing(a)).toBe(false);
    expect(result.current.requests.size).toBe(0);
  });

  it('is shared by every component of the client, and a new client starts empty', async () => {
    const first = setup([{ id: 'a', lastSync: null }]);
    act(() => first.result.current.mark('a'));
    await flush();
    const cached = first.client.getQueryData<SyncRequests>(keys.syncRequests);
    expect(cached?.get('a')).toBe(NOW);

    const second = setup([{ id: 'a', lastSync: null }]);
    expect(second.result.current.requests.size).toBe(0);
  });

  it('is not forgotten when the registry queries are invalidated', async () => {
    const a = { id: 'a', lastSync: null as unknown };
    const { client, result } = setup([a]);
    act(() => result.current.mark('a'));
    await flush();
    await act(async () => {
      await client.invalidateQueries({ queryKey: keys.registry });
    });
    expect(result.current.requests.get('a')).toBe(NOW);
  });
});
