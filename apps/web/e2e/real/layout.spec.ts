import { expect, type Locator, type Page, test } from '@playwright/test';
import { fillSource, goStep, signInAdmin, unique } from './helpers';

// 18.3: the Configuration and Authentication steps align on a shared grid. Labels, inputs, checkboxes and actions of a
// row sit on the same lines at 1280 px and narrower, and a hint never moves a neighbour.

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('not visible');
  return b;
};
const centreY = (b: { y: number; height: number }) => b.y + b.height / 2;

/** All controls of the row's first line: same top and height for inputs, same centre for checkbox and button. */
const expectAligned = async (row: Locator, inputs: Locator[], centred: Locator[]) => {
  const input = await Promise.all(inputs.map(box));
  for (const b of input) {
    expect(Math.abs(b.y - (input[0]?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs(b.height - 44)).toBeLessThanOrEqual(1);
  }
  const mid = centreY(input[0] as { y: number; height: number });
  for (const c of centred) {
    expect(Math.abs(centreY(await box(c)) - mid)).toBeLessThanOrEqual(2);
  }
  const labels = await row.locator('label').all();
  const tops = await Promise.all(
    labels.slice(0, inputs.length).map((l) => box(l).then((b) => b.y)),
  );
  for (const t of tops) expect(Math.abs(t - (tops[0] ?? 0))).toBeLessThanOrEqual(1);
};

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

for (const width of [1280, 900]) {
  test(`Configuration and Authentication rows are aligned at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await signInAdmin(page);
    await fillSource(page, {
      name: unique('Layout server').name,
      kind: 'npm',
      identifier: 'layout-mcp',
    });

    await goStep(page, /Configuration/);
    await page.getByRole('button', { name: 'Add variable' }).click();
    const v1 = page.getByRole('group', { name: 'Variable 1', exact: true });
    await v1.getByRole('textbox', { name: 'Name', exact: true }).fill('DATABASE_URL');
    await v1.getByLabel('Label').fill('Database URL');
    await page.getByRole('button', { name: 'Add variable' }).click();
    const v2 = page.getByRole('group', { name: 'Variable 2', exact: true });
    // A name that is not valid shows its error under the row, which must not shift the inputs above it.
    await v2.getByRole('textbox', { name: 'Name', exact: true }).fill('bad name');
    await v2.getByLabel('Default').fill('x');
    await page.getByRole('button', { name: 'Add environment variable' }).click();
    const e1 = page.getByRole('group', { name: 'Environment variable 1' });
    await e1.getByLabel('Name').fill('DATABASE_URL');
    await e1.getByLabel('Value').fill('{{var.DATABASE_URL}}');
    await page.getByRole('button', { name: 'Add argument' }).click();

    for (const row of [v1, v2]) {
      await expectAligned(
        row,
        [
          row.getByRole('textbox', { name: 'Name', exact: true }),
          row.getByLabel('Label'),
          row.getByLabel('Default'),
        ],
        [row.getByLabel('Required'), row.getByRole('button', { name: /Remove variable/ })],
      );
    }
    await expectAligned(
      e1,
      [e1.getByLabel('Name'), e1.getByLabel('Value')],
      [e1.getByLabel('Secret'), e1.getByRole('button', { name: /Remove environment variable/ })],
    );
    await noHorizontalScroll(page);
    await page.screenshot({
      path: `screenshots/catalog-configuration-${width}.png`,
      fullPage: true,
    });

    // Authentication: a header row of a remote server.
    await goStep(page, /Source/);
    await page.getByLabel('Runtime').selectOption('remote');
    await page.getByLabel('Server URL').fill('https://mcp.example.com/mcp');
    await goStep(page, /Authentication/);
    await page
      .getByRole('group', { name: 'Add header' })
      .getByRole('button', { name: 'Bearer token' })
      .click();
    await page
      .getByRole('group', { name: 'Add header' })
      .getByRole('button', { name: 'Custom header' })
      .click();
    const h1 = page.getByRole('group', { name: 'Header 1' });
    await expectAligned(
      h1,
      [h1.getByLabel('Header name'), h1.getByLabel('Value', { exact: true })],
      [h1.getByLabel('Secret', { exact: true }), h1.getByRole('button', { name: /Remove header/ })],
    );
    await noHorizontalScroll(page);
    await page.screenshot({
      path: `screenshots/catalog-authentication-${width}.png`,
      fullPage: true,
    });
  });
}
