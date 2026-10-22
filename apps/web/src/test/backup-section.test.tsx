import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

const PASS = 'a long enough passphrase';

describe('Backup and restore (settings)', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:backup');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is a section of Settings', async () => {
    await renderRoute('/settings?section=backup');
    expect(await screen.findByRole('heading', { name: 'Create a backup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backup and restore' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('creates a backup only with a matching passphrase of enough characters, then downloads it', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=backup');
    const create = await screen.findByRole('button', { name: 'Create and download backup' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText(/^Passphrase/), 'short');
    expect(screen.getByText(/at least 12 characters/i, { selector: '[role=alert]' })).toBeVisible();
    await user.clear(screen.getByLabelText(/^Passphrase/));
    await user.type(screen.getByLabelText(/^Passphrase/), PASS);
    await user.type(screen.getByLabelText(/Repeat the passphrase/), `${PASS}x`);
    expect(screen.getByText('The passphrases differ')).toBeVisible();
    expect(create).toBeDisabled();
    await user.clear(screen.getByLabelText(/Repeat the passphrase/));
    await user.type(screen.getByLabelText(/Repeat the passphrase/), PASS);
    await user.click(create);
    expect(await expectSent(capture, 'post', '/system/backup')).toEqual({ passphrase: PASS });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    capture.stop();
  });

  it('turns maintenance mode on and off', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=backup');
    await user.click(await screen.findByRole('button', { name: 'Stop all traffic' }));
    expect(await expectSent(capture, 'post', '/system/maintenance')).toEqual({ enabled: true });
    expect(await screen.findByText('Traffic stopped')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resume traffic' }));
    expect(await screen.findByText('Serving traffic')).toBeVisible();
    capture.stop();
  });

  it('previews a merge before restoring, and shows what the server says about a wrong passphrase', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=backup');
    const card = await screen.findByRole('region', { name: 'Restore' });
    const file = new File([new Uint8Array([1, 2, 3])], 'b.bastion-backup');
    await user.upload(within(card).getByLabelText(/Backup file/), file);
    await user.type(within(card).getByLabelText(/Backup passphrase/), PASS);
    expect(within(card).getByRole('button', { name: 'Restore' })).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    const body = (await expectSent(capture, 'post', '/system/restore')) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'merge', dryRun: true, passphrase: PASS });
    expect(await within(card).findByText(/Preview \(merge\)/)).toBeVisible();
    expect(within(card).getByText(/restored by a replace only/)).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Restore' })).toBeEnabled();

    await user.clear(within(card).getByLabelText(/Backup passphrase/));
    await user.type(within(card).getByLabelText(/Backup passphrase/), 'wrong passphrase!');
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(/wrong passphrase/);
    capture.stop();
  });

  it('a replace needs maintenance mode and a typed confirmation', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=backup');
    const card = await screen.findByRole('region', { name: 'Restore' });
    await user.upload(
      within(card).getByLabelText(/Backup file/),
      new File([new Uint8Array([1])], 'b.bastion-backup'),
    );
    await user.type(within(card).getByLabelText(/Backup passphrase/), PASS);
    await user.click(within(card).getByRole('radio', { name: /Replace/ }));
    expect(within(card).getByRole('status')).toHaveTextContent(/maintenance mode/);
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    await within(card).findByText(/Preview \(replace\)/);
    expect(within(card).getByRole('button', { name: 'Restore' })).toBeDisabled();

    await user.click(await screen.findByRole('button', { name: 'Stop all traffic' }));
    await screen.findByText('Traffic stopped');
    await user.click(within(card).getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace everything?' });
    const confirm = within(dialog).getByRole('button', { name: 'Replace everything' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type REPLACE/), 'REPLACE');
    await user.click(confirm);
    await waitFor(async () => {
      const sent = (await expectSent(capture, 'post', '/system/restore')) as Record<
        string,
        unknown
      >;
      expect(sent).toMatchObject({ mode: 'replace' });
    });
    capture.stop();
  });
});
