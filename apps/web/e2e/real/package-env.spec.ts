import { expect, test } from '@playwright/test';
import {
  apiCall,
  expectPublishReady,
  fillSource,
  goStep,
  makeUser,
  saveDraft,
  signIn,
  signInAdmin,
  state,
  unique,
} from './helpers';

// 8.1, 8.3, 9.5, 11.4: a package server (the stdio fake behind the real runner, as in apps/server sandbox tests) with
// environment variables: a fixed value, a value from an install-form variable, a personal secret, and arguments. The
// author tests it with their own values; a second user installs it, fills in the form, and the fake server reports the
// environment it received.

test('package server: fixed, variable and secret environment variables and arguments reach the process', async ({
  page,
  browser,
}) => {
  const s = await state();
  await signInAdmin(page);
  const app = unique('Env package server');
  // A secret name of its own, so the author's values from an earlier run do not satisfy the test form.
  const tok = `API_TOKEN_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  await fillSource(page, {
    name: app.name,
    kind: 'npm',
    identifier: 'fake-stdio',
    version: '1.0.0',
  });

  // Configuration: one variable people must fill in, two environment variables, one argument.
  await goStep(page, /Configuration/);
  await page.getByRole('button', { name: 'Add variable' }).click();
  const variable = page.getByRole('group', { name: 'Variable 1', exact: true });
  await variable.getByRole('textbox', { name: 'Name', exact: true }).fill('GREETING');
  await variable.getByLabel('Label').fill('Greeting');
  await variable.getByLabel('Description').fill('Said by the server');
  await page.getByRole('button', { name: 'Add environment variable' }).click();
  const env1 = page.getByRole('group', { name: 'Environment variable 1' });
  await env1.getByLabel('Name').fill('GREETING_ENV');
  await env1.getByLabel('Value').fill('{{var.GREETING}}');
  await page.getByRole('button', { name: 'Add environment variable' }).click();
  const env2 = page.getByRole('group', { name: 'Environment variable 2' });
  await env2.getByLabel('Name').fill('FIXED_ENV');
  await env2.getByLabel('Value').fill('fixed-value');
  await page.getByRole('button', { name: 'Add argument' }).click();
  const arg = page.getByRole('group', { name: 'Argument 1' });
  await arg.getByLabel('Argument type').selectOption('named');
  await arg.getByLabel('Flag').fill('--region');
  await arg.getByLabel('Argument value').fill('eu-{{var.GREETING}}');

  // Authentication: a personal secret, passed as an environment variable.
  await goStep(page, /Authentication/);
  await page.getByLabel('Personal secret').check();
  await page.getByRole('button', { name: 'Add secret environment variable' }).click();
  const secretRow = page.getByRole('group', { name: 'Environment variable 3' });
  await secretRow.getByLabel('Name').fill('SECRET_ENV');
  await secretRow.getByLabel('Value').fill(`{{secret.${tok}}}`);
  await expect(secretRow.getByLabel('Secret', { exact: true })).toBeChecked();
  await page.getByLabel(`Label for ${tok}`).fill('Your API token');

  const entryId = await saveDraft(page);
  const versions = (await apiCall(page, 'GET', `/catalog/${entryId}/versions`)).body as {
    items: { serverSpec: Record<string, unknown>; installForm: unknown }[];
  };
  expect(versions.items[0]?.serverSpec).toMatchObject({
    type: 'package',
    environmentVariables: [
      { name: 'GREETING_ENV', value: '{{var.GREETING}}' },
      { name: 'FIXED_ENV', value: 'fixed-value' },
    ],
    packageArguments: [{ type: 'named', name: '--region', value: 'eu-{{var.GREETING}}' }],
    auth: {
      mode: 'userSecret',
      fields: [{ name: tok, label: 'Your API token' }],
      inject: [{ to: 'env', name: 'SECRET_ENV', value: `{{secret.${tok}}}` }],
    },
  });

  // Test: the author gives their own values (required variable without default, personal secret).
  await goStep(page, /Test$/);
  await expect(page.getByRole('button', { name: 'Run test' })).toBeDisabled();
  await page.getByRole('region', { name: 'Test values' }).getByLabel('Greeting').fill('hello-test');
  await page.getByLabel('Your API token').fill('author-token');
  await page.getByRole('button', { name: 'Run test' }).click();
  await expectPublishReady(page);
  await page.getByLabel(/Everyone in/).check();
  await page.getByRole('button', { name: /^Publish v1\.0\.0$/ }).click();
  await page.waitForURL(/\/catalog$/);

  // A second user installs it: the form shows the variable and the secret, validates them, and stores them.
  await makeUser('carol@e2e.test', 'carols-long-password-1', 'Carol');
  const ctx = await browser.newContext({ baseURL: s.baseUrl });
  const carol = await ctx.newPage();
  await signIn(carol, 'carol@e2e.test', 'carols-long-password-1');
  await carol.goto(`/store?entry=${app.slug}`);
  await carol.getByRole('button', { name: 'Install', exact: true }).first().click();
  const dialog = carol.getByRole('dialog');
  await expect(dialog.getByLabel(/Greeting/)).toBeVisible();
  await expect(dialog.getByText('Said by the server')).toBeVisible();
  await expect(dialog.getByLabel(/Your API token/)).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(dialog.getByText('Greeting is required')).toBeVisible();
  await expect(dialog.getByText('Your API token is required')).toBeVisible();
  await dialog.getByLabel(/Greeting/).fill('hi-carol');
  await dialog.getByLabel(/Your API token/).fill('carols-secret');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(dialog.getByText(/is on your endpoint/)).toBeVisible({ timeout: 30_000 });
  const href = await dialog
    .getByRole('link', { name: new RegExp(`Open ${app.name}`) })
    .getAttribute('href');
  const id = /\/servers\/([0-9a-f-]{36})/.exec(href ?? '')?.[1] ?? '';

  const getenv = async (name: string): Promise<string> => {
    const r = await apiCall(carol, 'POST', `/installations/${id}/try`, {
      kind: 'tool',
      name: 'getenv',
      arguments: { name },
    });
    expect(r.status).toBe(200);
    return JSON.stringify(r.body);
  };
  expect(await getenv('GREETING_ENV')).toContain('hi-carol');
  expect(await getenv('FIXED_ENV')).toContain('fixed-value');
  expect(await getenv('SECRET_ENV')).toContain('carols-secret');
  const argv = await apiCall(carol, 'POST', `/installations/${id}/try`, {
    kind: 'tool',
    name: 'argv',
    arguments: {},
  });
  expect(JSON.stringify(argv.body)).toContain('--region');
  expect(JSON.stringify(argv.body)).toContain('eu-hi-carol');
  await ctx.close();
});
