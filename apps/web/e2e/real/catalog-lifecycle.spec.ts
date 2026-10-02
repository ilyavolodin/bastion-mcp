import { expect, type Page, test } from '@playwright/test';
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
} from './helpers';

// 11.1, 11.3, 18.3: the catalog lifecycle in a real browser against the real server. Entries are created for the fake
// remote server (as in remote-bearer.spec.ts), tested (the test passes), then published from the list row and from
// the editor, deleted (never tested, tested: the case that used to be a 409), deleted-or-refused when someone else
// installed them, deprecated and archived.

const SHOTS = process.env.E2E_SHOTS ?? '';
const rowOf = (page: Page, name: string) =>
  page.locator('li:not([data-sonner-toast])').filter({ hasText: name });

/** A saved draft entry for the fake remote server; with `tested` it also runs the test until it passes. */
const createDraft = async (
  page: Page,
  base: string,
  options: { tested: boolean; everyone?: boolean },
): Promise<{ name: string; slug: string; id: string }> => {
  const s = await state();
  const app = unique(base);
  await fillSource(page, { name: app.name, kind: 'remote', url: s.upstreamUrl });
  const id = await saveDraft(page);
  if (options.tested) {
    await goStep(page, /Test$/);
    await page.getByRole('button', { name: 'Run test' }).click();
    await expectPublishReady(page);
  }
  if (options.everyone) {
    await page.getByLabel(/Everyone in/).check();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  }
  return { ...app, id };
};

test.describe('catalog lifecycle', () => {
  test.setTimeout(480_000);

  test('publish from the list row and from the editor; delete drafts, tested or not', async ({
    page,
  }) => {
    await requireUpstreamToken(null);
    await resetUpstream();
    await signInAdmin(page);

    // --- A: tested draft, published from its row in the list ------------------------------------------------------
    const a = await createDraft(page, 'Lifecycle row', { tested: true, everyone: true });
    await page.goto('/catalog');
    const rowA = rowOf(page, a.name);
    await expect(rowA).toContainText('Test passed: ready to publish');
    await rowA.getByRole('button', { name: `Publish ${a.name}` }).click();
    const confirm = page.getByRole('dialog', { name: new RegExp(`Publish ${a.name} v0\\.1\\.0`) });
    await expect(confirm).toContainText('Everyone in the organization');
    await expect(confirm).toContainText('Passed for this exact version');
    await confirm.getByRole('button', { name: 'Publish v0.1.0' }).click();
    await expect(rowOf(page, a.name)).toContainText('Published', { timeout: 30_000 });
    const entryA = (await apiCall(page, 'GET', `/catalog/${a.id}`)).body as { status: string };
    expect(entryA.status).toBe('published');

    // --- B: tested draft, published from the Publish step of the editor ------------------------------------------
    const b = await createDraft(page, 'Lifecycle editor', { tested: true });
    await page.getByLabel(/Everyone in/).check();
    const panel = page.getByLabel('Ready to publish');
    const big = panel.getByRole('button', { name: 'Publish v0.1.0 to the Store' });
    await expect(big).toBeEnabled();
    await big.click();
    await page.waitForURL(/\/catalog$/);
    await expect(rowOf(page, b.name)).toContainText('Published', { timeout: 30_000 });

    // --- C: a never-tested draft says so, offers Test it, and deletes from the row ---------------------------------
    const c = await createDraft(page, 'Lifecycle untested', { tested: false });
    await page.goto('/catalog');
    const rowC = rowOf(page, c.name);
    await expect(rowC).toContainText('Not tested yet');
    await expect(rowC.getByRole('button', { name: /^Publish/ })).toHaveCount(0);
    await rowC.getByRole('link', { name: `Test ${c.name}` }).click();
    await expect(page).toHaveURL(/step=test/);
    await expect(page.getByRole('button', { name: 'Run test' })).toBeVisible();
    await page.goto('/catalog');
    await rowOf(page, c.name)
      .getByRole('button', { name: `Actions for ${c.name}` })
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialogC = page.getByRole('dialog', { name: `Delete ${c.name}?` });
    await expect(dialogC).toContainText('hidden test installation');
    await expect(dialogC.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialogC).toHaveCount(0);
    await expect(rowOf(page, c.name)).toHaveCount(1);
    await rowOf(page, c.name)
      .getByRole('button', { name: `Actions for ${c.name}` })
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete draft' }).click();
    await expect(rowOf(page, c.name)).toHaveCount(0);
    expect((await apiCall(page, 'GET', `/catalog/${c.id}`)).status).toBe(404);

    // --- D: a TESTED draft (it has a hidden test installation: this used to be a 409) deletes from the editor ------
    const d = await createDraft(page, 'Lifecycle tested', { tested: true });
    await page.getByRole('button', { name: 'Delete draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete draft' }).click();
    await page.waitForURL(/\/catalog$/);
    await expect(rowOf(page, d.name)).toHaveCount(0);
    expect((await apiCall(page, 'GET', `/catalog/${d.id}`)).status).toBe(404);
    const left = (await apiCall(page, 'GET', '/installations?limit=200')).body as {
      items: { catalogEntryId: string | null }[];
    };
    expect(left.items.some((i) => i.catalogEntryId === d.id)).toBe(false);

    // --- E: a tested draft deletes from its row too ----------------------------------------------------------------
    const e = await createDraft(page, 'Lifecycle row delete', { tested: true });
    await page.goto('/catalog');
    await rowOf(page, e.name)
      .getByRole('button', { name: `Actions for ${e.name}` })
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete draft' }).click();
    await expect(rowOf(page, e.name)).toHaveCount(0);
    expect((await apiCall(page, 'GET', `/catalog/${e.id}`)).status).toBe(404);
  });

  test('a published entry someone installed cannot be deleted; deprecate hides it from the Store; archive', async ({
    page,
    browser,
  }) => {
    const s = await state();
    await requireUpstreamToken(null);
    await resetUpstream();
    await signInAdmin(page);
    const a = await createDraft(page, 'Lifecycle used', { tested: true });
    await page.getByLabel(/Everyone in/).check();
    await page
      .getByLabel('Ready to publish')
      .getByRole('button', { name: /Publish v0\.1\.0 to/ })
      .click();
    await page.waitForURL(/\/catalog$/);

    // A second user installs it from the Store.
    await makeUser('bob@e2e.test', 'bobs-long-password-1', 'Bob');
    const bobCtx = await browser.newContext({ baseURL: s.baseUrl });
    const bob = await bobCtx.newPage();
    await signIn(bob, 'bob@e2e.test', 'bobs-long-password-1');
    await bob.goto(`/store?entry=${a.slug}`);
    await bob.getByRole('button', { name: 'Install', exact: true }).first().click();
    const dialog = bob.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(dialog.getByText(/is on your endpoint/)).toBeVisible({ timeout: 30_000 });
    const storeSlugs = async () =>
      (
        (await apiCall(bob, 'GET', '/store?limit=100')).body as { items: { slug: string }[] }
      ).items.map((i) => i.slug);
    expect(await storeSlugs()).toContain(a.slug);

    // The list offers no Delete for it, and the API refuses with the guidance.
    await page.goto('/catalog');
    await rowOf(page, a.name)
      .getByRole('button', { name: `Actions for ${a.name}` })
      .click();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/list-menu.png` });
    await expect(
      page.getByRole('menuitem', { name: /Delete \(1 installation use it\)/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    const refused = await apiCall(page, 'DELETE', `/catalog/${a.id}`, undefined, {
      'if-match': '*',
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(
      /1 installation uses this entry.*Deprecate it to hide it from the Store, or remove the installations first/,
    );
    expect(
      ((await apiCall(page, 'GET', `/catalog/${a.id}`)).body as { status: string }).status,
    ).toBe('published');

    // Deprecate: the confirmation explains the effect; the entry leaves the Store, the installation stays.
    await page.getByRole('menuitem', { name: 'Deprecate' }).click();
    const dep = page.getByRole('dialog', { name: `Deprecate ${a.name}?` });
    await expect(dep).toContainText('disappears from the Store');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/confirm-deprecate.png` });
    await dep.getByRole('button', { name: 'Deprecate' }).click();
    await expect(rowOf(page, a.name)).toContainText('Deprecated', { timeout: 30_000 });
    expect(await storeSlugs()).not.toContain(a.slug);
    const mine = (await apiCall(bob, 'GET', '/installations?limit=100')).body as {
      items: { catalogEntryId: string | null }[];
    };
    expect(mine.items.some((i) => i.catalogEntryId === a.id)).toBe(true);

    // Archive: allowed while the installation exists (it marks the entry).
    await rowOf(page, a.name)
      .getByRole('button', { name: `Actions for ${a.name}` })
      .click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await page
      .getByRole('dialog', { name: `Archive ${a.name}?` })
      .getByRole('button', { name: 'Archive' })
      .click();
    await expect(rowOf(page, a.name)).toContainText('Archived', { timeout: 30_000 });
    expect(await storeSlugs()).not.toContain(a.slug);
    await bobCtx.close();
  });

  test('screenshots at 1280 px: the list with the actions menu and the delete confirmation', async ({
    page,
  }) => {
    test.skip(!SHOTS, 'set E2E_SHOTS to a directory to take screenshots');
    await page.setViewportSize({ width: 1280, height: 800 });
    await requireUpstreamToken(null);
    await resetUpstream();
    await signInAdmin(page);
    const t = await createDraft(page, 'Shot tested', { tested: true, everyone: true });
    const u = await createDraft(page, 'Shot untested', { tested: false });
    // The editor on its Publish step, as the owner will find it.
    await page.goto(`/catalog/${t.id}?step=publish`);
    await expect(page.getByLabel('Ready to publish')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/editor-publish-step.png` });
    await page.goto(`/catalog/${t.id}?step=source`);
    await expect(
      page.getByText('This version passed its test: it is ready to publish.'),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/editor-ready-banner.png` });
    await page.goto('/catalog');
    await expect(rowOf(page, t.name)).toContainText('Test passed: ready to publish');
    await rowOf(page, u.name)
      .getByRole('button', { name: `Actions for ${u.name}` })
      .click();
    await page.screenshot({ path: `${SHOTS}/list-actions-menu.png` });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('dialog', { name: `Delete ${u.name}?` })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/confirm-delete.png` });
    await page.keyboard.press('Escape');
    await rowOf(page, t.name)
      .getByRole('button', { name: `Publish ${t.name}` })
      .click();
    await expect(page.getByRole('dialog', { name: /Publish/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/confirm-publish.png` });
    await page.keyboard.press('Escape');
    // Clean up the drafts so reruns start clean.
    for (const x of [t, u])
      await apiCall(page, 'DELETE', `/catalog/${x.id}`, undefined, { 'if-match': '*' });
  });
});
