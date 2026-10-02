import { expect, type Page, test } from '@playwright/test';
import {
  apiCall,
  fillSource,
  goStep,
  requireUpstreamToken,
  saveDraft,
  signInAdmin,
  state,
  unique,
} from './helpers';

// 11.3, 12.2: a saved draft opens again with everything in it; an empty override document is valid and never blocks.

const overridesEditor = (page: Page) =>
  page.locator('.monaco-editor[aria-label="Default override document"]');

const setOverrides = async (page: Page, text: string) => {
  await overridesEditor(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
};

const variableRow = (page: Page) => page.getByRole('group', { name: 'Variable 1', exact: true });

test('saving a draft and opening it again keeps every step, and empty overrides are valid', async ({
  page,
}) => {
  const s = await state();
  await requireUpstreamToken(null);
  await signInAdmin(page);
  const app = unique('Round trip server');
  await fillSource(page, { name: app.name, kind: 'remote', url: s.upstreamUrl });
  await page.getByLabel('Description').fill('Opened again and again');

  await goStep(page, /Configuration/);
  await page.getByRole('button', { name: 'Add variable' }).click();
  await variableRow(page).getByRole('textbox', { name: 'Name', exact: true }).fill('TENANT');
  await variableRow(page).getByLabel('Default').fill('acme');
  await goStep(page, /Authentication/);
  await page
    .getByRole('group', { name: 'Add header' })
    .getByRole('button', { name: 'Custom header' })
    .click();
  await page.getByLabel('Header name').fill('X-Tenant');
  await page.getByLabel('Value', { exact: true }).fill('{{var.TENANT}}');
  await goStep(page, /Security/);
  await page.getByLabel('When a tool definition changes').selectOption('warn');
  const id = await saveDraft(page);

  // A version that stores `{}` as its overrides (as the API does for an empty document) opens as the empty document.
  const versions = (await apiCall(page, 'GET', `/catalog/${id}/versions`)).body as {
    items: { overrides: unknown }[];
  };
  expect(versions.items[0]?.overrides).toEqual({});

  await page.goto(`/catalog/${id}?step=overrides`);
  await expect(overridesEditor(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Valid\. Empty/)).toBeVisible();
  // Never a dead end: Next reaches Security and limits, where the saved choice is back.
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByLabel('When a tool definition changes')).toHaveValue('warn');

  // Every other step shows what was saved.
  await goStep(page, /Source/);
  await expect(page.getByLabel('Display name')).toHaveValue(app.name);
  await expect(page.getByLabel('Description')).toHaveValue('Opened again and again');
  await expect(page.getByLabel('Server URL')).toHaveValue(s.upstreamUrl);
  await goStep(page, /Configuration/);
  await expect(variableRow(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'TENANT',
  );
  await expect(variableRow(page).getByLabel('Default')).toHaveValue('acme');
  await goStep(page, /Authentication/);
  await expect(page.getByLabel('Header name')).toHaveValue('X-Tenant');
  await expect(page.getByLabel('Value', { exact: true })).toHaveValue('{{var.TENANT}}');

  // Overrides: {} and {"version":1} are both fine; an invalid document is explained and blocks Save, not navigation.
  await goStep(page, /Overrides/);
  await setOverrides(page, '{}');
  await expect(page.getByText(/^Valid\. Empty/)).toBeVisible();
  await setOverrides(page, '{ "version": 1 }');
  await expect(page.getByText(/^Valid\. Empty/)).toBeVisible();
  await setOverrides(page, '{ "version": 2 }');
  await expect(page.getByRole('alert').filter({ hasText: /version/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/The override document is not valid/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByRole('region', { name: 'Security and limits' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await setOverrides(page, '{ "version": 1, "tools": { "echo": { "title": "Say it" } } }');
  await expect(page.getByText('Valid override document.')).toBeVisible();
  const putOverrides = () =>
    page.waitForResponse((r) => r.url().endsWith('/overrides') && r.request().method() === 'PUT');
  const firstPut = putOverrides();
  await page.getByRole('button', { name: 'Save draft' }).click();
  expect((await firstPut).status()).toBe(200);
  const saved = (await apiCall(page, 'GET', `/catalog/${id}/versions`)).body as {
    items: { overrides: unknown }[];
  };
  expect(saved.items[0]?.overrides).toMatchObject({ tools: { echo: { title: 'Say it' } } });

  // And back to empty: the document is replaced, not left behind.
  await setOverrides(page, '{}');
  const secondPut = putOverrides();
  await page.getByRole('button', { name: 'Save draft' }).click();
  expect((await secondPut).status()).toBe(200);
  const cleared = (await apiCall(page, 'GET', `/catalog/${id}/versions`)).body as {
    items: { overrides: unknown }[];
  };
  // The server stores the normalized empty document: version 1 and no entries.
  expect(cleared.items[0]?.overrides).toMatchObject({ version: 1, tools: {} });
});
