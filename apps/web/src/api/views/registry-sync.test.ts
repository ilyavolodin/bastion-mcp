import { describe, expect, it } from 'vitest';
import { REGISTRY_SYNC_SKEW_MS, REGISTRY_SYNC_TIMEOUT_MS } from '../timing';
import {
  isSyncing,
  NO_SYNC_REQUESTS,
  pruneSyncRequests,
  type SyncRequests,
  withSyncRequested,
} from './registry';

const T0 = Date.parse('2026-10-03T10:00:00.000Z');

const stats = (finishedAt: string, ok = true) => ({
  startedAt: finishedAt,
  finishedAt,
  ok,
  full: false,
  pages: 1,
  fetched: 1,
  upserted: 1,
  invalid: 0,
  deleted: 0,
  deprecated: 0,
});
const source = (id: string, finishedAt?: string) => ({
  id,
  lastSync: finishedAt ? stats(finishedAt) : null,
});
const iso = (ms: number) => new Date(ms).toISOString();

describe('registry sync state (15.6)', () => {
  it('a source nobody asked to sync is not syncing', () => {
    expect(isSyncing(source('a'), NO_SYNC_REQUESTS, T0)).toBe(false);
  });

  it('after a request it syncs until the source reports a walk that finished after the click', () => {
    const requested = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    expect(isSyncing(source('a'), requested, T0 + 1000)).toBe(true);
    // An older result than the click: still waiting.
    expect(isSyncing(source('a', iso(T0 - 60_000)), requested, T0 + 1000)).toBe(true);
    // A newer one: done.
    expect(isSyncing(source('a', iso(T0 + 30_000)), requested, T0 + 31_000)).toBe(false);
  });

  it('allows for clock skew between the server and the browser', () => {
    const requested = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    const justInside = iso(T0 - REGISTRY_SYNC_SKEW_MS);
    const justOutside = iso(T0 - REGISTRY_SYNC_SKEW_MS - 1);
    expect(isSyncing(source('a', justInside), requested, T0 + 1)).toBe(false);
    expect(isSyncing(source('a', justOutside), requested, T0 + 1)).toBe(true);
  });

  it('gives up after 15 minutes without a result', () => {
    const requested = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    expect(REGISTRY_SYNC_TIMEOUT_MS).toBe(15 * 60_000);
    expect(isSyncing(source('a'), requested, T0 + REGISTRY_SYNC_TIMEOUT_MS)).toBe(true);
    expect(isSyncing(source('a'), requested, T0 + REGISTRY_SYNC_TIMEOUT_MS + 1)).toBe(false);
  });

  it('a result of any kind counts, including a failed walk', () => {
    const requested = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    const failed = { id: 'a', lastSync: stats(iso(T0 + 5000), false) };
    expect(isSyncing(failed, requested, T0 + 6000)).toBe(false);
  });

  it('ignores a lastSync that is not sync stats', () => {
    const requested = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    expect(isSyncing({ id: 'a', lastSync: { nope: true } }, requested, T0 + 1)).toBe(true);
    expect(isSyncing({ id: 'a', lastSync: 'x' }, requested, T0 + 1)).toBe(true);
  });

  it('is pure: the same arguments always answer the same, and the requests are not changed', () => {
    const requested = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    const s = source('a', iso(T0 + 1000));
    expect(isSyncing(s, requested, T0 + 2000)).toBe(isSyncing(s, requested, T0 + 2000));
    expect([...requested]).toEqual([['a', T0]]);
  });

  it('withSyncRequested returns a new map and replaces an older request of the same source', () => {
    const one = withSyncRequested(NO_SYNC_REQUESTS, 'a', T0);
    const two = withSyncRequested(one, 'a', T0 + 5);
    const three = withSyncRequested(two, 'b', T0 + 6);
    expect(NO_SYNC_REQUESTS.size).toBe(0);
    expect(one.get('a')).toBe(T0);
    expect(two.get('a')).toBe(T0 + 5);
    expect([...three.keys()]).toEqual(['a', 'b']);
  });

  describe('pruneSyncRequests', () => {
    const requests: SyncRequests = new Map([
      ['done', T0],
      ['waiting', T0],
      ['old', T0 - REGISTRY_SYNC_TIMEOUT_MS - 1],
      ['unknown', T0],
    ]);
    const sources = [source('done', iso(T0 + 1000)), source('waiting'), source('old')];

    it('forgets what reported or timed out and keeps the rest, also for a source not listed', () => {
      const pruned = pruneSyncRequests(sources, requests, T0 + 2000);
      expect([...pruned.keys()]).toEqual(['waiting', 'unknown']);
    });

    it('answers the same map when there is nothing to forget', () => {
      const keep = withSyncRequested(NO_SYNC_REQUESTS, 'waiting', T0);
      expect(pruneSyncRequests(sources, keep, T0 + 2000)).toBe(keep);
      expect(pruneSyncRequests([], NO_SYNC_REQUESTS, T0)).toBe(NO_SYNC_REQUESTS);
    });

    it('forgets an unknown source once it has timed out', () => {
      const pruned = pruneSyncRequests([], requests, T0 + REGISTRY_SYNC_TIMEOUT_MS + 1);
      expect(pruned.size).toBe(0);
    });
  });
});
