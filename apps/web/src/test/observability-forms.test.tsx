import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/mocks/db';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * The observability forms (drift decisions, Activity filters) are used through the real screens; what reaches the API
 * is validated against the OpenAPI schema (ajv) and checked for the values the user typed (13.6, 15.5, 17.2).
 */

describe('Observability forms send what the API requires (17.2)', () => {
  it('13.6 keeping a definition blocked sends the reason the user typed', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/security');
    await user.click(await screen.findByRole('button', { name: /Keep blocking get_event/ }));
    const dialog = await screen.findByRole('dialog', { name: /Keep blocking get_event/ });
    await user.type(within(dialog).getByLabelText(/Reason/), '  Mirrors events to Slack  ');
    await user.click(within(dialog).getByRole('button', { name: 'Keep blocking' }));
    expect(await expectSent(capture, 'post', '/drift-reviews/dr-1/reject')).toEqual({
      reason: 'Mirrors events to Slack',
    });
    await waitFor(() =>
      expect(getDb().data.observability.drift.find((d) => d.id === 'dr-1')?.status).toBe(
        'rejected',
      ),
    );
    capture.stop();
  });

  it('13.6 a rejection without a reason is not sent, the dialog says why', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/security');
    await user.click(await screen.findByRole('button', { name: /Keep blocking get_event/ }));
    const dialog = await screen.findByRole('dialog', { name: /Keep blocking get_event/ });
    await user.click(within(dialog).getByRole('button', { name: 'Keep blocking' }));
    expect(
      await within(dialog).findByText(/Say why the new definition stays blocked/, {
        selector: 'p[role="alert"]',
      }),
    ).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'post' && c.path.includes('/reject'))).toBe(
      false,
    );
    capture.stop();
  });

  it('13.6 accepting a clean definition sends the optional note, or an empty body without one', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/security');
    await user.click(await screen.findByRole('button', { name: /create_pull_request/ }));
    await user.click(await screen.findByRole('button', { name: 'Accept new definition' }));
    const dialog = await screen.findByRole('dialog', { name: /Accept create_pull_request/ });
    await user.type(within(dialog).getByLabelText(/Note/), 'Draft PRs are fine');
    await user.click(within(dialog).getByRole('button', { name: 'Accept definition' }));
    expect(await expectSent(capture, 'post', '/drift-reviews/dr-2/approve')).toEqual({
      note: 'Draft PRs are fine',
    });
    await waitFor(() =>
      expect(getDb().data.observability.drift.find((d) => d.id === 'dr-2')?.status).toBe(
        'approved',
      ),
    );
    capture.stop();

    const second = captureRequests();
    await user.click(await screen.findByRole('button', { name: /search_tickets/ }));
    await user.click(await screen.findByRole('button', { name: 'Accept new definition' }));
    const again = await screen.findByRole('dialog', { name: /Accept search_tickets/ });
    await user.click(within(again).getByRole('button', { name: 'Accept definition' }));
    expect(await expectSent(second, 'post', '/drift-reviews/dr-3/approve')).toEqual({});
    second.stop();
  });

  it('15.5 the Activity filters become the API query: outcome, installation and a time window', async () => {
    const capture = captureRequests();
    await renderRoute('/activity?outcome=blocked&server=i-postgres&range=1h');
    await capture.next('get', '/calls');
    await vi.waitFor(() =>
      expect(
        capture.calls.some((c) => c.path.endsWith('/calls') && c.search.includes('limit=50')),
      ).toBe(true),
    );
    const list = capture.calls.find(
      (c) => c.path.endsWith('/calls') && c.search.includes('limit=50'),
    );
    const q = new URLSearchParams(list?.search);
    expect(q.get('outcome')).toBe('blocked');
    expect(q.get('installation')).toBe('i-postgres');
    const from = new Date(q.get('from') ?? '').getTime();
    const to = new Date(q.get('to') ?? '').getTime();
    expect(to - from).toBe(3_600_000);
    capture.stop();
  });

  it('10.1 a member asks for their own calls, which is all the call log lets them read', async () => {
    const capture = captureRequests();
    await renderRoute('/activity', { role: 'member' });
    const sent = await capture.next('get', '/calls');
    expect(new URLSearchParams(sent.search).get('user')).toBe(getDb().me.id);
    capture.stop();
  });

  it('10.1 a manager without a filter asks for their team’s calls', async () => {
    const capture = captureRequests();
    await renderRoute('/activity', { role: 'manager' });
    const sent = await capture.next('get', '/calls');
    expect(new URLSearchParams(sent.search).get('team')).toBe('t-platform');
    capture.stop();
  });
});
