import { expect, test } from '@playwright/test';
import { apiCall, signInAdmin, unique } from './helpers';

// 17.1: a change to a stored row names the row's version in If-Match; the real API answers 428 without it. The console
// takes the version from the list it loaded, so editing a row from a list works against the real server.

test('editing an identity provider connection from the list saves (If-Match from the list)', async ({
  page,
}) => {
  await signInAdmin(page);
  const first = unique('Synology SSO').name;
  const second = `${first} (renamed)`;
  const created = await apiCall(page, 'POST', '/idp-connections', {
    name: first,
    issuer: 'https://sso.example.test/webman/sso',
    discoveryUrl: 'https://sso.example.test/webman/sso/.well-known/openid-configuration',
    clientId: 'bastion',
    clientSecret: 'not-a-real-secret',
    enabled: false,
  });
  expect(created.status).toBe(201);
  const id = (created.body as { id: string }).id;

  await page.goto('/settings?section=idp');
  const row = page.getByRole('listitem').filter({ hasText: first });
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByLabel(/^Name( \*)?$/);
  await name.fill(second);
  await dialog.getByRole('button', { name: 'Save connection' }).click();

  await expect(page.getByText('Connection saved')).toBeVisible();
  await expect(dialog).toBeHidden();
  const stored = (await apiCall(page, 'GET', `/idp-connections/${id}`)).body as { name: string };
  expect(stored.name).toBe(second);

  // A second edit of the same row works too: the version moved on with the first save.
  await page
    .getByRole('listitem')
    .filter({ hasText: second })
    .getByRole('button', { name: 'Edit' })
    .click();
  await dialog.getByLabel(/^Name( \*)?$/).fill(first);
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(
      async () =>
        ((await apiCall(page, 'GET', `/idp-connections/${id}`)).body as { name: string }).name,
    )
    .toBe(first);
  const again = (await apiCall(page, 'GET', `/idp-connections/${id}`)).body as { name: string };
  expect(again.name).toBe(first);
});
