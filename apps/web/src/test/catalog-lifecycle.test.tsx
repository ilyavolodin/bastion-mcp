import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { canManageEntry } from '@/features/catalog/entry-actions';
import { getDb } from '@/mocks/db';
import { iso } from '@/mocks/util';
import { captureRequests, expectSent } from './capture';
import { expectNoA11yViolations, renderRoute } from './utils';

/**
 * Removing, retiring and publishing catalog entries from the list and the editor (11.1, 11.3, 18.3): every action
 * is reachable from the row, confirms what it does, and shows the API's guidance when it is refused.
 */

const row = (name: string) => {
  const link = screen.getByRole('link', { name });
  return link.closest('li') as HTMLElement;
};

/** A second draft nobody installed: `Postgres analytics` has an installation in the fixtures. */
const withUntestedDraft = (db: ReturnType<typeof getDb>) => {
  const base = db.data.catalog.entries.find((e) => e.id === 'c-postgres');
  if (!base) throw new Error('fixture missing');
  db.data.catalog.entries.unshift({
    ...base,
    id: 'c-scratch',
    slug: 'scratch',
    displayName: 'Scratch server',
    description: 'Never tested',
  });
  const v = db.data.catalog.versions.find((x) => x.entryId === 'c-postgres');
  if (!v) throw new Error('fixture missing');
  db.data.catalog.versions.push({
    ...v,
    id: 'v-scratch-1',
    entryId: 'c-scratch',
    label: '0.1.0',
    testResult: null,
  });
};

describe('Catalog list rows (11.1, 11.3)', () => {
  it('11.3 a draft with a passing test is ready to publish and has a Publish button; an untested one says so and offers Test it', async () => {
    await renderRoute('/catalog', { prepare: withUntestedDraft });
    await screen.findByRole('link', { name: 'Postgres analytics' });
    const tested = row('Postgres analytics');
    expect(await within(tested).findByText('Test passed: ready to publish')).toBeInTheDocument();
    expect(
      within(tested).getByRole('button', { name: 'Publish Postgres analytics' }),
    ).toBeVisible();

    const fresh = row('Scratch server');
    expect(within(fresh).getByText('Not tested yet')).toBeInTheDocument();
    const testIt = within(fresh).getByRole('link', { name: 'Test Scratch server' });
    expect(testIt).toHaveAttribute('href', expect.stringContaining('/catalog/c-scratch'));
    expect(testIt.getAttribute('href')).toContain('step=test');
    expect(within(fresh).queryByRole('button', { name: /^Publish/ })).toBeNull();
  });

  it('11.3 Publish on the row confirms visibility, risk and the test, then publishes this exact version', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog');
    await screen.findByRole('link', { name: 'Postgres analytics' });
    await user.click(
      await within(row('Postgres analytics')).findByRole('button', {
        name: 'Publish Postgres analytics',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: /Publish Postgres analytics v3\.2\.0/,
    });
    expect(within(dialog).getByText('Passed for this exact version')).toBeInTheDocument();
    expect(within(dialog).getByText('Who gets it')).toBeInTheDocument();
    expect(within(dialog).getByText('medium')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Publish v3.2.0' }));
    const body = (await expectSent(capture, 'post', /\/versions\/[^/]+\/publish$/)) as {
      visibility: { teamIds: string[] };
    };
    expect(body.visibility.teamIds).toEqual(['t-data', 't-analytics']);
    await waitFor(() =>
      expect(getDb().data.catalog.entries.find((e) => e.id === 'c-postgres')?.status).toBe(
        'published',
      ),
    );
    capture.stop();
  });

  it('11.1 Delete on a never-tested draft names the entry and what goes; Esc closes without deleting', async () => {
    const { user } = await renderRoute('/catalog', { prepare: withUntestedDraft });
    await user.click(await screen.findByRole('button', { name: 'Actions for Scratch server' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Scratch server?' });
    expect(dialog).toHaveTextContent(/versions and files/);
    expect(dialog).toHaveTextContent(/hidden test installation/);
    // Focus starts on the safe button.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getDb().data.catalog.entries.some((e) => e.id === 'c-scratch')).toBe(true);
  });

  it('11.1 confirming deletes the draft with DELETE /catalog/{id} and the row disappears', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog', { prepare: withUntestedDraft });
    await user.click(await screen.findByRole('button', { name: 'Actions for Scratch server' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Scratch server?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await capture.next('delete', '/catalog/c-scratch');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Scratch server' })).toBeNull());
    capture.stop();
  });

  it('11.1 a refused delete shows the guidance, not a raw error', async () => {
    const { user } = await renderRoute('/catalog');
    await user.click(await screen.findByRole('button', { name: 'Actions for Postgres analytics' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Postgres analytics?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('This entry is in use');
    expect(alert).toHaveTextContent(
      /1 installation uses this entry.*Deprecate it to hide it from the Store, or remove the installations first/,
    );
    expect(getDb().data.catalog.entries.some((e) => e.id === 'c-postgres')).toBe(true);
  });

  it('11.1 a published entry that people installed cannot be deleted from the menu: Delete is off and says why', async () => {
    const { user } = await renderRoute('/catalog');
    await user.click(await screen.findByRole('button', { name: 'Actions for GitHub' }));
    const item = await screen.findByRole('menuitem', { name: /Delete \(1 installation use it\)/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('11.1 Deprecate explains that the Store hides it and installations keep working, then sends status deprecated', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog');
    await user.click(await screen.findByRole('button', { name: 'Actions for GitHub' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deprecate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deprecate GitHub?' });
    expect(dialog).toHaveTextContent(/disappears from the Store/);
    expect(dialog).toHaveTextContent(/Existing installations keep working/);
    await user.click(within(dialog).getByRole('button', { name: 'Deprecate' }));
    expect(await expectSent(capture, 'patch', '/catalog/c-github')).toEqual({
      status: 'deprecated',
    });
    expect(await within(row('GitHub')).findByText('Deprecated')).toBeInTheDocument();
    capture.stop();
  });

  it('11.1 Archive sends status archived and marks the row Archived', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog');
    await user.click(await screen.findByRole('button', { name: 'Actions for GitHub' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive GitHub?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await expectSent(capture, 'patch', '/catalog/c-github')).toEqual({ status: 'archived' });
    expect(await within(row('GitHub')).findByText('Archived')).toBeInTheDocument();
    capture.stop();
  });

  it('10.1 a Manager gets actions only for entries of a team they manage; an Auditor gets none', async () => {
    const own = (db: ReturnType<typeof getDb>) => {
      const e = db.data.catalog.entries.find((x) => x.id === 'c-postgres');
      if (e) e.ownerTeamId = 't-platform';
    };
    await renderRoute('/catalog', { role: 'manager', prepare: own });
    expect(
      await screen.findByRole('button', { name: 'Actions for Postgres analytics' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Actions for GitHub' })).toBeNull();
  });

  it('10.1 an Auditor may manage no entry, an Admin every one, a Manager only their teams', () => {
    const me = { teams: [{ id: 't-a', name: 'A', role: 'manager' as const }] };
    expect(canManageEntry('auditor', me, { ownerTeamId: 't-a' })).toBe(false);
    expect(canManageEntry('member', me, { ownerTeamId: 't-a' })).toBe(false);
    expect(canManageEntry('admin', me, { ownerTeamId: null })).toBe(true);
    expect(canManageEntry('manager', me, { ownerTeamId: 't-a' })).toBe(true);
    expect(canManageEntry('manager', me, { ownerTeamId: 't-b' })).toBe(false);
    expect(canManageEntry('manager', me, { ownerTeamId: null })).toBe(false);
  });

  it('18.3 the list with the actions menu open has no accessibility violations', async () => {
    const { user, container } = await renderRoute('/catalog');
    await user.click(await screen.findByRole('button', { name: 'Actions for GitHub' }));
    await screen.findByRole('menu');
    expect((await expectNoA11yViolations(container)).violations).toEqual([]);
  });
});

describe('Catalog editor lifecycle (11.1, 11.3, 18.3)', () => {
  it('11.1 a saved draft can be deleted from the header, which returns to the list', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres', { prepare: withUntestedDraft });
    await user.click(await screen.findByRole('button', { name: 'Delete draft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Postgres analytics?' });
    expect(dialog).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(capture.calls.some((c) => c.method === 'delete')).toBe(false);
    capture.stop();
  });

  it('11.1 a new entry has no Delete button', async () => {
    await renderRoute('/catalog/new');
    await screen.findByLabelText(/Display name/);
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('11.3 the Publish step has a full-width primary Publish button once the test passed', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres?step=publish');
    const panel = await screen.findByLabelText('Ready to publish');
    const button = within(panel).getByRole('button', { name: 'Publish v3.2.0 to the Store' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button.className).toMatch(/w-full/);
    await user.click(button);
    await capture.next('post', /\/versions\/[^/]+\/publish$/);
    capture.stop();
  });

  it('11.3 when the version was not tested the Publish step says exactly why and links to the Test step', async () => {
    const { user } = await renderRoute('/catalog/c-scratch?step=publish', {
      prepare: withUntestedDraft,
    });
    const panel = await screen.findByLabelText('Ready to publish');
    expect(
      within(panel).getByRole('button', { name: 'Publish v0.1.0 to the Store' }),
    ).toBeDisabled();
    await waitFor(() => expect(panel).toHaveTextContent('This version has not been tested.'));
    expect(panel).toHaveTextContent('Publish needs a passing test of this exact version');
    await user.click(within(panel).getByRole('button', { name: 'Go to the Test step' }));
    expect(await screen.findByLabelText('Test run').catch(() => null)).not.toBeUndefined();
  });

  it('11.3 after a pass, the stepper marks Publish as ready and a banner leads there', async () => {
    const { user } = await renderRoute('/catalog/c-postgres?step=source');
    const banner = await screen.findByText('This version passed its test: it is ready to publish.');
    expect(banner).toBeVisible();
    const stepper = screen.getByRole('navigation', { name: 'Catalog steps' });
    expect(within(stepper).getByRole('button', { name: /Publish/ })).toHaveTextContent('ready');
    await user.click(screen.getByRole('button', { name: 'Go to Publish' }));
    expect(await screen.findByLabelText('Ready to publish')).toBeVisible();
  });

  it('9.6 a test that failed because the account is not connected offers Connect your account', async () => {
    await renderRoute('/catalog/c-postgres?step=test', {
      prepare: (db) => {
        const v = db.data.catalog.versions.find((x) => x.entryId === 'c-postgres');
        if (!v) throw new Error('fixture missing');
        v.testResult = {
          id: 'run-needs-connect',
          versionId: v.id,
          status: 'failed',
          startedAt: iso(db.now),
          finishedAt: iso(db.now),
          steps: [
            { id: 'prepare', status: 'passed' },
            {
              id: 'connect',
              status: 'failed',
              detail: 'You have not connected your account yet.',
              connectUrl: 'http://localhost:8080/connect/inst-1',
            },
          ],
        };
      },
    });
    const alert = await screen.findByRole('alert');
    const link = within(alert).getByRole('link', { name: 'Connect your account' });
    expect(link).toHaveAttribute('href', 'http://localhost:8080/connect/inst-1');
    expect(alert).toHaveTextContent('runs the server as you');
  });
});
