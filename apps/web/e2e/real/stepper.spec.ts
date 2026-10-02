import { expect, type Page, test } from '@playwright/test';
import {
  fillSource,
  goStep,
  requireUpstreamToken,
  resetUpstream,
  signInAdmin,
  state,
  unique,
} from './helpers';

// 11.3: Test then Publish. The stepper moves on after a passing test, Publish is available for exactly that tested
// version, and a failing or running test never traps the author: the reason is shown and every step stays reachable.

const publishButton = (page: Page) =>
  page
    .getByRole('region', { name: 'Publish', exact: true })
    .getByRole('button', { name: /^Publish v/ });

test('a new unsaved entry is saved and tested in one flow, then Publish is available', async ({
  page,
}) => {
  const s = await state();
  await requireUpstreamToken(null);
  await resetUpstream();
  await signInAdmin(page);
  await fillSource(page, {
    name: unique('One flow server').name,
    kind: 'remote',
    url: s.upstreamUrl,
  });
  await goStep(page, /Test$/);
  // Nothing is saved yet: the Test step offers to save and run in one go, and Publish says what is missing.
  await expect(publishButton(page)).toBeDisabled();
  await expect(page.getByText('Save the draft and run its test to publish it.')).toBeVisible();
  await page.getByRole('button', { name: 'Save and run test' }).click();

  // The editor advances to Publish by itself once the test passes.
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page
      .getByRole('navigation', { name: 'Catalog steps' })
      .getByRole('button', { name: /Publish/ }),
  ).toHaveAttribute('aria-current', 'step');
  await expect(publishButton(page)).toBeEnabled();
  await expect(page.getByText(/This exact version passed its test/)).toBeVisible();

  // Back and Next never dead-end: Back returns to the passed test, Next returns to Publish.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('region', { name: 'Test start' })).toContainText('The test passed');
  await expect(page.getByRole('button', { name: 'Next step' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible();

  // Changing who gets it or the risk does not invalidate the test: Publish stays available.
  await page.getByRole('button', { name: 'Medium' }).click();
  await expect(publishButton(page)).toBeEnabled();
});

test('a failing test shows why, keeps every step reachable, and a fix then passes', async ({
  page,
}) => {
  const s = await state();
  await requireUpstreamToken(null);
  await signInAdmin(page);
  await fillSource(page, {
    name: unique('Dead then alive').name,
    kind: 'remote',
    url: 'http://127.0.0.1:9/mcp',
  });
  await goStep(page, /Test$/);
  await page.getByRole('button', { name: 'Save and run test' }).click();

  const alert = page.getByRole('alert').filter({ hasText: 'The test failed' });
  await expect(alert).toBeVisible({ timeout: 60_000 });
  await expect(alert).toContainText('Connect to the server');
  // Still on the Test step, Publish unavailable with the reason, steps navigable.
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toHaveCount(0);
  await expect(publishButton(page)).toBeDisabled();
  await expect(
    page.getByText('The last test failed. Fix the problem and run the test again.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible();
  await expect(page.getByText(/The last test failed/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Go to the test' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('region', { name: 'Security and limits' })).toBeVisible();

  // Fix the URL on the Source step: the old result no longer counts, the next run saves and tests the new version.
  await goStep(page, /Source/);
  await page.getByLabel('Server URL').fill(s.upstreamUrl);
  await goStep(page, /Test$/);
  await expect(publishButton(page)).toBeDisabled();
  await expect(page.getByText(/You changed this version since its last test/)).toBeVisible();
  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(publishButton(page)).toBeEnabled();
});
