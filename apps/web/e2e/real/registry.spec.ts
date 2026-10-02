import { expect, test } from '@playwright/test';
import { apiCall, makeUser, signIn, signInAdmin } from './helpers';

/**
 * The Registry end to end against the REAL server (the official source answers from a local fake registry of 60
 * remote servers): enable the preconfigured source in Settings, watch the first sync, browse in pages, search,
 * ask for an install as a member and approve it as the admin.
 */
test('registry: enable, sync, browse in pages, search, request and approve', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signInAdmin(page);

  // Disabled by default: nothing is listed and the screen says why.
  await page.goto('/registry');
  await expect(page.getByText('No registry is enabled.').first()).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);

  // Settings -> Registry: enable the official source; the first sync starts by itself.
  await page.goto('/settings?section=registry');
  const row = page.getByRole('listitem', { name: 'Official MCP Registry' });
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await row.getByRole('switch', { name: 'Enable Official MCP Registry' }).click();
  await expect(row.getByText(/Last sync .* 60 entries/)).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText('Enabled', { exact: true }).first()).toBeVisible();

  // The install policy: remote servers, request mode, members may ask (managers and admins approve).
  await row.getByRole('button', { name: 'Install policy' }).click();
  const policy = page.getByRole('dialog', { name: /Install policy/ });
  await policy.getByLabel('Mode').selectOption('request');
  await policy.getByLabel('Who may install').selectOption('everyone');
  await policy.getByRole('button', { name: 'Save policy' }).click();
  await expect(policy).toBeHidden();

  // Browse: one page of 24, provenance on every card, Load more fetches the next page only.
  await page.goto('/registry');
  const strip = page.getByRole('region', { name: 'Active registries' });
  await expect(strip.getByText('Official MCP Registry')).toBeVisible();
  await expect(strip.getByText(/60 entries/)).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(24);
  await expect(
    page.getByRole('article').first().getByText('Official', { exact: true }),
  ).toBeVisible();
  const pages: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/registry/servers?')) pages.push(r.url());
  });
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('article')).toHaveCount(48);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toContain('cursor=');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('article')).toHaveCount(60);
  await expect(page.getByText('End of results')).toBeVisible();

  // Search resets paging.
  await page.getByRole('searchbox', { name: 'Search registries' }).fill('payments');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'io.e2e/payments' })).toBeVisible();

  // A member asks to install it (request mode).
  const member = `member-registry-${Date.now()}@e2e.test`;
  await makeUser(member, 'Registry-member-1!', 'Registry Member');
  const ctx = await browser.newContext({ baseURL: page.url().split('/registry')[0] });
  const mp = await ctx.newPage();
  await signIn(mp, member, 'Registry-member-1!');
  await mp.goto('/registry');
  await mp.getByRole('searchbox', { name: 'Search registries' }).fill('payments');
  const card = mp.getByRole('article').filter({ hasText: 'io.e2e/payments' });
  await card.getByRole('button', { name: 'Install' }).click();
  const dialog = mp.getByRole('dialog', { name: /Request io\.e2e\/payments/ });
  await dialog.getByLabel(/What do you need it for/).fill('Quarterly revenue review');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(card.getByText('Requested')).toBeVisible();
  await ctx.close();

  // The admin approves it: a catalog entry and the member's installation exist afterwards.
  await page.goto('/registry');
  const requests = page
    .getByRole('region', { name: 'Install requests' })
    .or(page.getByLabel('Install requests'));
  await expect(requests.getByText('io.e2e/payments')).toBeVisible();
  await requests.getByRole('button', { name: 'Approve' }).click();
  await expect(requests.getByText('No open requests.')).toBeVisible();
  const catalog = await apiCall(page, 'GET', '/catalog');
  const entries = (catalog.body as { items: { slug: string; source: { kind: string } }[] }).items;
  expect(JSON.stringify(entries), 'catalog entries').toContain('io.e2e/payments');
  const installations = await apiCall(page, 'GET', '/installations?limit=200');
  const names = JSON.stringify(installations.body);
  expect(names).toContain('payments');
});

test('registry: a disabled source is explained and never offers Install', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/settings?section=registry');
  const row = page.getByRole('listitem', { name: 'Official MCP Registry' });
  const toggle = row.getByRole('switch', { name: 'Enable Official MCP Registry' });
  if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await page.goto('/registry');
  await expect(page.getByText('No registry is enabled.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Registry settings' })).toBeVisible();
});
