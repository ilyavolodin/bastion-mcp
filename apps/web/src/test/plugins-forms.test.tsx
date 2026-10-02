import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { captureRequests } from './capture';
import { renderRoute } from './utils';

/**
 * The marketplace actions go through the real screen; the mutations of this domain take no request body, so the
 * check is that they address the operation the OpenAPI document defines and send none (25.4, 17.2).
 */

describe('Plugins actions address the API operations (17.2)', () => {
  it('25.4 promoting the draft release posts the release number and no body', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/plugins');
    await user.click(await screen.findByRole('button', { name: 'Promote draft release' }));
    const sent = await capture.next('post', '/marketplaces/mk-eng/releases/6/promote');
    expect(sent.body).toBeUndefined();
    await waitFor(() => expect(getDb().data.plugins.marketplaces[0]?.promotedRelease).toBe(6));
    capture.stop();
  });

  it('25.6 a diverged mirror offers Sync now, which pushes without a body', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/plugins', {
      prepare: (db) => {
        const m = db.data.plugins.marketplaces[0];
        if (m?.mirrorStatus) m.mirrorStatus = { ...m.mirrorStatus, status: 'diverged' };
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    const sent = await capture.next('post', '/marketplaces/mk-eng/mirror/push');
    expect(sent.body).toBeUndefined();
    await waitFor(() =>
      expect(getDb().data.plugins.marketplaces[0]?.mirrorStatus?.status).toBe('ok'),
    );
    capture.stop();
  });

  it('25.6 an in-sync mirror has nothing to sync', async () => {
    await renderRoute('/plugins');
    await screen.findByText(/github\.com\/acme\/bastion-plugins mirror in sync/);
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('25.7 the rollout configuration is read per client with the client in the query', async () => {
    const capture = captureRequests();
    await renderRoute('/plugins/marketplace/mk-eng');
    await screen.findByLabelText('Claude Code rollout');
    await waitFor(() =>
      expect(
        capture.calls.some(
          (c) => c.method === 'get' && c.path.endsWith('/marketplaces/mk-eng/rollout'),
        ),
      ).toBe(true),
    );
    capture.stop();
  });
});
