import { expect, test } from '@playwright/test';

// Runs against the Vite dev server in MSW mode: `?as=` picks the signed-in role (src/mocks/browser.ts), and the
// navigation follows the role (src/lib/roles.ts, 18.2).

const NAV = ['Observability', 'Security', 'Catalog', 'Registry', 'Access', 'Settings'] as const;

const VISIBLE: Record<string, readonly (typeof NAV)[number][]> = {
  member: ['Registry'],
  auditor: ['Observability', 'Security'],
  manager: ['Observability', 'Security', 'Catalog', 'Registry', 'Access'],
};

for (const [role, visible] of Object.entries(VISIBLE)) {
  test(`${role}: the navigation offers only what the role may open`, async ({ page }) => {
    await page.goto(`/?as=${role}`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    for (const label of NAV) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await expect(link).toHaveCount(visible.includes(label) ? 1 : 0);
    }
  });
}

test('a member who types the URL of Settings is told only Admins see it', async ({ page }) => {
  await page.goto('/settings?as=member');
  await expect(page.getByRole('heading', { name: 'Only Admins see Settings' })).toBeVisible();
});

test('an auditor who types the URL of the catalog is told it is not in their navigation', async ({
  page,
}) => {
  await page.goto('/catalog?as=auditor');
  await expect(page.getByRole('heading', { name: /Not in this role.s navigation/ })).toBeVisible();
});

test('the catalog editor opens a draft for a manager and walks to its first step', async ({
  page,
}) => {
  await page.goto('/?as=manager');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Catalog' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Catalog' })).toBeVisible();
  await page.goto('/catalog/new?as=manager');
  await expect(page.getByLabel(/Display name/)).toBeVisible();
});
