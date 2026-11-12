import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useInstallations } from '@/api/hooks/servers';
import { resetDb } from '@/mocks/db';
import { server } from '@/mocks/server';
import { captureRequests } from './capture';

/**
 * Baseline for what the installations list reads and which version it says each installation runs (7.1): an
 * installation that is not pinned follows the entry's newest version, a pinned one stays, and the requests that find
 * the labels are the versions of the entries, one request per version id.
 */

const row = (id: string, over: Record<string, unknown>) => ({
  id,
  slug: id,
  displayName: id.toUpperCase(),
  ownerType: 'team',
  ownerId: 'nobody',
  personalSpec: null,
  catalogEntryId: null,
  catalogVersionId: null,
  pinnedVersion: false,
  ...over,
});

const ROWS = [
  row('i1', { catalogEntryId: 'e1', catalogVersionId: 'v1', pinnedVersion: false }),
  row('i2', { catalogEntryId: 'e1', catalogVersionId: 'v1', pinnedVersion: true }),
  row('i3', { catalogEntryId: 'e2', catalogVersionId: 'v9', pinnedVersion: false }),
  row('i4', { catalogEntryId: null, catalogVersionId: null }),
  row('i5', { catalogEntryId: 'e3', catalogVersionId: 'v5', pinnedVersion: true }),
  row('i6', { catalogEntryId: 'e4', catalogVersionId: 'v2', pinnedVersion: true }),
];

const CURRENT: Record<string, string | null> = { e1: 'v2', e3: null, e4: 'v7' };

const install = () => {
  const page = (items: unknown[]) => HttpResponse.json({ items, nextCursor: null });
  server.use(
    http.get('*/api/v1/installations', () => page(ROWS)),
    http.get('*/api/v1/users', () => page([])),
    http.get('*/api/v1/teams', () => page([])),
    http.get('*/api/v1/catalog/:id', ({ params }) => {
      const id = String(params.id);
      return id in CURRENT
        ? HttpResponse.json({ id, currentVersionId: CURRENT[id] })
        : HttpResponse.json(
            { title: 'Not Found', status: 404, code: 'not_found' },
            { status: 404 },
          );
    }),
    http.get('*/api/v1/catalog/:id/versions/:vid', ({ params }) => {
      if (params.vid === 'v9') return HttpResponse.json({ status: 404 }, { status: 404 });
      return HttpResponse.json({
        id: params.vid,
        label: `label ${params.vid} via ${params.id}`,
        serverSpec: { type: 'remote', url: 'https://example.com/mcp' },
      });
    }),
  );
};

describe('7.1 the version each installation runs', () => {
  it('follows the entry unless pinned, falls back to the installed version when the entry cannot be read, and asks for each version once', async () => {
    resetDb('admin');
    install();
    const capture = captureRequests();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInstallations(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 20_000 });
    await capture.next('get', '/catalog/e4/versions/v7');
    const views = (result.current.data ?? []).map((v) => [
      v.id,
      v.versionLabel,
      v.latestVersionLabel,
      v.followsCurrent,
    ]);
    expect(views).toEqual([
      ['i1', 'label v2 via e4', null, true],
      ['i2', 'label v1 via e1', 'label v2 via e4', false],
      ['i3', null, null, true],
      ['i4', null, null, false],
      ['i5', 'label v5 via e3', null, false],
      ['i6', 'label v2 via e4', 'label v7 via e4', false],
    ]);
    const catalog = capture.calls
      .filter((c) => c.path.includes('/catalog/'))
      .map((c) => c.path.replace('/api/v1', ''));
    // One read per entry (in the order of the rows), then one per version id: a version two entries share is asked
    // of the last of them, and a version nobody can name (the entry is unreadable) is still asked of its entry.
    expect(catalog).toEqual([
      '/catalog/e1',
      '/catalog/e2',
      '/catalog/e3',
      '/catalog/e4',
      '/catalog/e4/versions/v2',
      '/catalog/e1/versions/v1',
      '/catalog/e2/versions/v9',
      '/catalog/e3/versions/v5',
      '/catalog/e4/versions/v7',
    ]);
  });
});
