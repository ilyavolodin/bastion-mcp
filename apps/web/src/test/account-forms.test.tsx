import { screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { MOCK_PASSWORD } from '@/mocks/domains/session';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

describe('Account: change password (9.1)', () => {
  it('9.1 the user menu offers the account page', async () => {
    const { user } = await renderRoute('/');
    await user.click(await screen.findByRole('button', { name: /Account menu for/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Account and password' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
  });

  it('9.1 sends the current and the new password and shows a confirmation', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/account');
    await user.type(await screen.findByLabelText(/Current password/), MOCK_PASSWORD);
    await user.type(screen.getByLabelText(/^New password/), 'a brand new passphrase');
    await user.type(screen.getByLabelText(/Repeat the new password/), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await expectSent(capture, 'post', '/me/password')).toEqual({
      currentPassword: MOCK_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    await waitFor(() => expect(screen.getByLabelText(/Current password/)).toHaveValue(''));
    capture.stop();
  });

  it('9.1 short, repeated or mismatched passwords are not sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/account');
    await user.type(await screen.findByLabelText(/Current password/), 'old password value');
    await user.type(screen.getByLabelText(/^New password/), 'short');
    await user.type(screen.getByLabelText(/Repeat the new password/), 'other');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('The passwords do not match')).toBeInTheDocument();
    expect(capture.calls.some((c) => c.path.endsWith('/me/password'))).toBe(false);
    capture.stop();
  });

  it('9.1 a wrong current password is shown next to its field', async () => {
    const { user } = await renderRoute('/account');
    await user.type(await screen.findByLabelText(/Current password/), 'not the password');
    await user.type(screen.getByLabelText(/^New password/), 'a brand new passphrase');
    await user.type(screen.getByLabelText(/Repeat the new password/), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('The current password is not correct.', {
        selector: 'p[role="alert"]',
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Current password/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('9.1 the form uses the right autocomplete hints and has no accessibility violations', async () => {
    const { container } = await renderRoute('/account');
    await screen.findByRole('heading', { level: 1, name: 'Account' });
    expect(screen.getByLabelText(/Current password/)).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(screen.getByLabelText(/^New password/)).toHaveAttribute('autocomplete', 'new-password');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Account: connected apps (9.4)', () => {
  it('9.4 lists the apps the person authorized, in words, and revoking one asks first and removes it', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/account');
    const card = await screen.findByRole('region', { name: 'Connected apps' });
    expect(await within(card).findByText('https://claude.ai/oauth/client.json')).toBeVisible();
    expect(card).toHaveTextContent('Use your MCP servers, Stay signed in');

    await user.click(within(card).getByRole('button', { name: /^Revoke https:\/\/claude\.ai/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this app?' });
    // Nothing is sent until the person confirms; Cancel keeps the app.
    expect(capture.calls.some((c) => c.method === 'delete')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke access' }));

    // The row's version from the list goes in If-Match (the test setup fails on a change without one, 17.1).
    await capture.next('delete', '/me/oauth-grants/g-claude');
    await waitFor(() =>
      expect(within(card).queryByText('https://claude.ai/oauth/client.json')).toBeNull(),
    );
    expect(await within(card).findByText('No connected apps')).toBeVisible();
    capture.stop();
  });
});
