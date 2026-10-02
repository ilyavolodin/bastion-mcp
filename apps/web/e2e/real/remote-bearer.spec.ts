import { expect, test } from '@playwright/test';
import {
  apiCall,
  expectPublishReady,
  fillSource,
  goStep,
  makeUser,
  requireUpstreamToken,
  resetUpstream,
  saveDraft,
  signIn,
  signInAdmin,
  state,
  unique,
  upstreamRequests,
} from './helpers';

// 9.5, 11.3, 11.4: a remote server behind `Authorization: Bearer <token>`. The author sets a SHARED secret once; a
// second user installs the published entry and calls a tool; the fake upstream, which answers 401 without the header,
// proves the gateway sent it.

const TOKEN = 'lan-token-0123456789';

test('remote server with a shared bearer token: author, publish, install as a second user, tool call', async ({
  page,
  browser,
}) => {
  const s = await state();
  await requireUpstreamToken(TOKEN);
  await resetUpstream();
  await signInAdmin(page);

  const app = unique('LAN bearer server');
  await fillSource(page, { name: app.name, kind: 'remote', url: s.upstreamUrl });
  await goStep(page, /Authentication/);
  // Presets: Bearer token, API key header, custom header.
  for (const preset of ['Bearer token', 'API key header', 'Custom header']) {
    await expect(
      page.getByRole('group', { name: 'Add header' }).getByRole('button', { name: preset }),
    ).toBeVisible();
  }
  await page
    .getByRole('group', { name: 'Add header' })
    .getByRole('button', { name: 'Bearer token' })
    .click();
  await expect(page.getByLabel('Shared secret')).toBeChecked();
  await expect(page.getByLabel('Header name')).toHaveValue('Authorization');
  await expect(page.getByLabel('Value', { exact: true })).toHaveValue('Bearer {{secret.TOKEN}}');
  await expect(page.getByLabel('Secret', { exact: true })).toBeChecked();
  // A secret name of its own, so a rerun against the same stack starts from "Not set".
  const secretName = `LAN_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await page.getByLabel('Value', { exact: true }).fill(`Bearer {{secret.${secretName}}}`);
  // The token is entered once, as a password field, and is shown as "Not set" until saved.
  await expect(page.getByRole('region', { name: 'Secrets' })).toContainText('Not set');
  await page.getByLabel(`Value of ${secretName}`).fill(TOKEN);
  await expect(page.getByLabel(`Value of ${secretName}`)).toHaveAttribute('type', 'password');

  const entryId = await saveDraft(page);
  // The spec references the secret; the secret itself went to the secrets API and is never returned.
  const entry = (await apiCall(page, 'GET', `/catalog/${entryId}/versions`)).body as {
    items: { serverSpec: unknown; id: string }[];
  };
  expect(JSON.stringify(entry.items[0]?.serverSpec)).toContain(`{{secret.${secretName}}}`);
  expect(JSON.stringify(entry)).not.toContain(TOKEN);
  const secrets = (await apiCall(page, 'GET', '/secrets?scope=org')).body as {
    items: { name: string }[];
  };
  expect(secrets.items.map((x) => x.name)).toContain(secretName);
  expect(JSON.stringify(secrets)).not.toContain(TOKEN);

  // After the save the field shows "Set" and an empty box, never the value.
  await page.reload();
  await goStep(page, /Authentication/);
  await expect(page.getByRole('region', { name: 'Secrets' })).toContainText('Set');
  await expect(page.getByLabel(`Value of ${secretName}`)).toHaveValue('');

  // Test: the gateway sends the header, the test passes, and the editor moves on to Publish by itself.
  await goStep(page, /^7\s*Test|Test$/);
  await page.getByRole('button', { name: 'Run test' }).click();
  await expectPublishReady(page);
  const publish = page.getByRole('button', { name: /^Publish v0\.1\.0$/ });
  await expect(publish).toBeEnabled();
  await page.getByLabel(/Everyone in/).check();
  await publish.click();
  await page.waitForURL(/\/catalog$/);

  const duringTest = await upstreamRequests();
  expect(duringTest.some((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  expect(duringTest.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

  // A second user installs it from the Store and calls a tool through the gateway.
  await makeUser('bob@e2e.test', 'bobs-long-password-1', 'Bob');
  const bobCtx = await browser.newContext({ baseURL: s.baseUrl });
  const bob = await bobCtx.newPage();
  await signIn(bob, 'bob@e2e.test', 'bobs-long-password-1');
  await resetUpstream();
  await bob.goto(`/store?entry=${app.slug}`);
  await bob.getByRole('button', { name: 'Install', exact: true }).first().click();
  const dialog = bob.getByRole('dialog');
  // A shared secret asks the installer for nothing.
  await expect(dialog.getByText('Nothing to fill in')).toBeVisible();
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(dialog.getByText(/is on your endpoint/)).toBeVisible({ timeout: 30_000 });
  const href = await dialog
    .getByRole('link', { name: new RegExp(`Open ${app.name}`) })
    .getAttribute('href');
  const installationId = /\/servers\/([0-9a-f-]{36})/.exec(href ?? '')?.[1] ?? '';
  expect(installationId).not.toBe('');

  const call = await apiCall(bob, 'POST', `/installations/${installationId}/try`, {
    kind: 'tool',
    name: 'echo',
    arguments: { text: 'hello through bastion' },
  });
  expect(call.status).toBe(200);
  expect(JSON.stringify(call.body)).toContain('hello through bastion');

  const seen = await upstreamRequests();
  const toolCalls = seen.filter((r) => r.rpc === 'tools/call');
  expect(toolCalls.length).toBeGreaterThan(0);
  expect(toolCalls.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  await bobCtx.close();
});

test('remote server with a PERSONAL bearer token: each installer enters their own, and it reaches the upstream', async ({
  page,
  browser,
}) => {
  const s = await state();
  const MINE = 'author-own-token-777';
  // (the secret name `mine` is chosen below)
  const BOBS = 'bobs-own-token-999';
  await requireUpstreamToken(MINE);
  await resetUpstream();
  await signInAdmin(page);

  const app = unique('Personal bearer server');
  await fillSource(page, { name: app.name, kind: 'remote', url: s.upstreamUrl });
  await goStep(page, /Authentication/);
  await page.getByLabel('Personal secret').check();
  await page
    .getByRole('group', { name: 'Add header' })
    .getByRole('button', { name: 'Bearer token' })
    .click();
  await expect(page.getByLabel('Personal secret')).toBeChecked();
  // A secret name of its own: the author's earlier values (same stack, earlier run) must not satisfy the test form.
  const mine = `MINE_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await page.getByLabel('Value', { exact: true }).fill(`Bearer {{secret.${mine}}}`);
  await page.getByLabel(`Label for ${mine}`).fill('Your LAN token');
  const entryId = await saveDraft(page);
  const versions = (await apiCall(page, 'GET', `/catalog/${entryId}/versions`)).body as {
    items: { installForm: { secrets: { name: string; label: string }[] } }[];
  };
  expect(versions.items[0]?.installForm.secrets).toEqual([{ name: mine, label: 'Your LAN token' }]);

  // The test starts the server as the author: it asks for the author's own value first.
  await goStep(page, /Test$/);
  await expect(page.getByRole('region', { name: 'Test values' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run test' })).toBeDisabled();
  await page.getByLabel('Your LAN token').fill(MINE);
  await page.getByRole('button', { name: 'Run test' }).click();
  await expectPublishReady(page);
  await page.getByLabel(/Everyone in/).check();
  await page.getByRole('button', { name: /^Publish v0\.1\.0$/ }).click();
  await page.waitForURL(/\/catalog$/);

  await makeUser('bob@e2e.test', 'bobs-long-password-1', 'Bob');
  const bobCtx = await browser.newContext({ baseURL: s.baseUrl });
  const bob = await bobCtx.newPage();
  await signIn(bob, 'bob@e2e.test', 'bobs-long-password-1');
  await requireUpstreamToken(BOBS);
  await resetUpstream();
  await bob.goto(`/store?entry=${app.slug}`);
  await bob.getByRole('button', { name: 'Install', exact: true }).first().click();
  const dialog = bob.getByRole('dialog');
  // The install form asks Bob for his own token, as a password field, and will not install without it.
  const field = dialog.getByLabel('Your LAN token');
  await expect(field).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(dialog.getByText('Your LAN token is required')).toBeVisible();
  await field.fill(BOBS);
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(dialog.getByText(/is on your endpoint/)).toBeVisible({ timeout: 30_000 });
  const href = await dialog
    .getByRole('link', { name: new RegExp(`Open ${app.name}`) })
    .getAttribute('href');
  const installationId = /\/servers\/([0-9a-f-]{36})/.exec(href ?? '')?.[1] ?? '';

  const call = await apiCall(bob, 'POST', `/installations/${installationId}/try`, {
    kind: 'tool',
    name: 'echo',
    arguments: { text: 'personal hello' },
  });
  expect(call.status).toBe(200);
  expect(JSON.stringify(call.body)).toContain('personal hello');
  const seen = (await upstreamRequests()).filter((r) => r.rpc === 'tools/call');
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((r) => r.authorization === `Bearer ${BOBS}`)).toBe(true);
  await bobCtx.close();
});
