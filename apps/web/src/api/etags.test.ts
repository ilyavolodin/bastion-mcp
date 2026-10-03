import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { api, clearEtags, configureApi } from './client';

const seenIfMatch = () => {
  const seen: (string | null)[] = [];
  server.use(
    http.get('*/api/v1/settings', () => HttpResponse.json({}, { headers: { ETag: '"v1"' } })),
    http.patch('*/api/v1/settings', ({ request }) => {
      seen.push(request.headers.get('if-match'));
      return HttpResponse.json({});
    }),
  );
  return seen;
};

describe('remembered ETags end with the session', () => {
  afterEach(() => configureApi({ onUnauthorized: () => undefined }));

  it('clearEtags forgets what a GET remembered', async () => {
    const seen = seenIfMatch();
    await api.get('/settings');
    await api.patch('/settings', {});
    clearEtags();
    await api.patch('/settings', {});
    expect(seen).toEqual(['"v1"', null]);
  });

  it("a 401 clears them, so the next person never sends this one's versions", async () => {
    const seen = seenIfMatch();
    configureApi({ onUnauthorized: () => undefined });
    await api.get('/settings');
    server.use(
      http.get('*/api/v1/drift-reviews', () =>
        HttpResponse.json(
          { status: 401, title: 'Nope' },
          { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    await api.get('/drift-reviews').catch(() => undefined);
    await api.patch('/settings', {});
    expect(seen).toEqual([null]);
  });
});
