import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Runs against the Vite dev server in MSW mode (`pnpm dev`): no login, no backend.

test('Home renders with the endpoint and installation tiles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await expect(page.getByText('https://bastion.acme.dev/mcp')).toBeVisible();
  await expect(page.getByRole('link', { name: /Postgres analytics/ })).toBeVisible();
});

test('install a server from the Store', async ({ page }) => {
  await page.goto('/store?entry=servicedesk');
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await dialog.getByRole('button', { name: /Connect with/ }).click();
  await expect(dialog.getByText('ServiceDesk is on your endpoint')).toBeVisible();
  await expect(dialog.getByText(/mcpServers/).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  // The mock API lives in memory, so navigate inside the app instead of reloading.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('link', { name: /ServiceDesk/ })).toBeVisible();
});

test('open an Activity call drawer with the trace waterfall', async ({ page }) => {
  await page.goto('/activity');
  await page
    .getByRole('button', { name: /pg_run_query/ })
    .first()
    .click();
  const drawer = page.getByRole('complementary', { name: 'Call detail' });
  await expect(drawer.getByText('Where the time went')).toBeVisible();
  await expect(drawer.getByText(/Request guard · SQL write pattern/)).toBeVisible();
});

test('switch theme from the user menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitemcheckbox', { name: /Dark theme/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('SSE live update reaches the notification bell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Notifications, 2 unread/ })).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __bastionMock: { emit: (e: string, d: unknown) => void } }
    ).__bastionMock.emit('notification', {
      id: 'n-live',
      kind: 'info',
      title: 'Live',
      body: 'Pushed over SSE',
      href: null,
      createdAt: new Date().toISOString(),
      readAt: null,
    }),
  );
  await expect(page.getByRole('button', { name: /Notifications, 3 unread/ })).toBeVisible();
});

test('role preview is off by default and switchable with ?rolePreview=1', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Role preview' })).toHaveCount(0);
  await page.goto('/?rolePreview=1');
  await page.getByRole('button', { name: 'Member' }).click();
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});

for (const path of ['/', '/store', '/activity', '/security', '/access']) {
  test(`axe: ${path} has no serious violations (light and dark)`, async ({ page }) => {
    for (const theme of ['light', 'dark']) {
      await page.goto(path);
      await page.waitForSelector('main h1');
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
        .analyze();
      const bad = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
    }
  });
}

test('layout: sidebar collapses to icons below 1280 px and Home stays usable under 768 px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  expect((await nav.boundingBox())?.width).toBeLessThan(100);
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(page.getByText('Connect your AI tools')).toBeVisible();
});
