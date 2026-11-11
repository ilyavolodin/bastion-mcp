import { describe, expect, it } from 'vitest';
import { type Installation, runningVersions, versionsToFetch } from '@/api/views/servers';

const row = (id: string, over: Partial<Installation>): Installation =>
  ({
    id,
    catalogEntryId: null,
    catalogVersionId: null,
    pinnedVersion: false,
    ...over,
  }) as Installation;

describe('7.1 runningVersions and versionsToFetch', () => {
  const rows = [
    row('a', { catalogEntryId: 'e1', catalogVersionId: 'v1' }),
    row('b', { catalogEntryId: 'e1', catalogVersionId: 'v1', pinnedVersion: true }),
    row('c', { catalogEntryId: 'e2', catalogVersionId: 'v9' }),
    row('d', {}),
  ];
  const current = new Map<string, string | null>([['e1', 'v2']]);

  it('a pinned installation stays, the others follow the entry, an unreadable entry falls back, a personal one is absent', () => {
    expect([...runningVersions(rows, current)]).toEqual([
      ['a', { running: 'v2', latest: 'v2' }],
      ['b', { running: 'v1', latest: 'v2' }],
      ['c', { running: 'v9', latest: null }],
    ]);
  });

  it('each version id is asked once, in order, of the entry of the last installation naming it', () => {
    const versions = runningVersions(rows, current);
    expect(versionsToFetch(rows, versions)).toEqual([
      ['v2', 'e1'],
      ['v1', 'e1'],
      ['v9', 'e2'],
    ]);
    const shared = [
      ...rows,
      row('e', { catalogEntryId: 'e3', catalogVersionId: 'v2', pinnedVersion: true }),
    ];
    expect(versionsToFetch(shared, runningVersions(shared, current))[0]).toEqual(['v2', 'e3']);
  });
});
