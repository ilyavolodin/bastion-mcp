import { expect, test } from '@playwright/test';
import { apiCall, fillSource, goStep, signInAdmin, unique } from './helpers';

// 11.1: the editor lets an Admin create a team where it asks for one (owner, audience), and selects it.

test('creating a team from the catalog editor works end to end', async ({ page }) => {
  await signInAdmin(page);
  const team1 = unique('Platform engineering').name;
  const team2 = unique('Data analytics').name;
  await fillSource(page, {
    name: unique('Team test server').name,
    kind: 'npm',
    identifier: 'team-test-mcp',
  });

  // Owner: the "New team…" entry of the Owner picker creates and selects the team.
  await page.getByLabel('Owner').selectOption({ label: 'New team…' });
  const dialog = page.getByRole('dialog', { name: 'New team' });
  await dialog.getByLabel(/Team name/).fill(team1);
  await expect(dialog.getByLabel(/URL name/)).toHaveValue(/^platform-engineering-/);
  await dialog.getByRole('button', { name: 'Create team' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Owner')).toContainText(`Team · ${team1}`);
  await expect(page.getByLabel('Owner')).toHaveValue(/.+/);

  // Audience: the "New team…" entry of the Add team picker adds a second team to "Selected teams" and shows it as a chip.
  await goStep(page, /Publish/);
  await page.getByLabel('Add team').selectOption({ label: 'New team…' });
  await dialog.getByLabel(/Team name/).fill(team2);
  await dialog.getByRole('button', { name: 'Create team' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `Remove ${team2}` })).toBeVisible();
  // The picker lists the teams that exist, including the one created a moment ago, minus the selected ones.
  const options = await page.getByLabel('Add team').locator('option').allTextContents();
  expect(options.join('|')).toContain(team1);
  expect(options.join('|')).not.toContain(team2);

  // Both teams exist on the server; the entry is created with the owner team and the audience.
  const teams = (await apiCall(page, 'GET', '/teams')).body as { items: { displayName: string }[] };
  expect(teams.items.map((t) => t.displayName)).toEqual(expect.arrayContaining([team1, team2]));
  await goStep(page, /Source/);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.waitForURL(/\/catalog\/[0-9a-f-]{36}/);
  const id = /\/catalog\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  const entry = (await apiCall(page, 'GET', `/catalog/${id}`)).body as {
    ownerTeamId: string | null;
  };
  expect(entry.ownerTeamId).not.toBeNull();
});
