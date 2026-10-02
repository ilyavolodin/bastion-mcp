import { test } from '@playwright/test';

// Captures the main screens in both themes into apps/web/screenshots (compared against docs/design).
const SCREENS: [string, string][] = [
  ['home', '/'],
  ['store', '/store?entry=jira'],
  ['installation', '/servers/i-postgres'],
  ['overrides', '/servers/i-postgres?tab=overrides'],
  ['activity', '/activity?call=call-0001'],
  ['observability', '/observability'],
  ['security', '/security'],
  ['catalog-editor', '/catalog/c-postgres?step=test'],
  ['access', '/access'],
  ['settings', '/settings?section=system'],
  ['plugins', '/plugins'],
];

for (const theme of ['light', 'dark'] as const) {
  for (const [name, path] of SCREENS) {
    test(`screenshot ${name} (${theme})`, async ({ page }) => {
      await page.goto(path);
      await page.waitForSelector('main h1');
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `screenshots/${name}-${theme}.png`, fullPage: true });
    });
  }
}
