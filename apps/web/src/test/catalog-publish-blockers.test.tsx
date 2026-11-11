import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { getDb } from '@/mocks/db';
import { iso } from '@/mocks/util';
import { renderRoute } from './utils';

/**
 * Why the Publish step cannot publish (11.3): the headline in the "Ready to publish" card and the hint under it,
 * which the side card repeats under its Publish button, for each of the five states.
 */

type Db = ReturnType<typeof getDb>;

const versionOf = (db: Db, entryId: string) => {
  const v = db.data.catalog.versions.find((x) => x.entryId === entryId);
  if (!v) throw new Error('fixture missing');
  return v;
};

const untestedDraft = (db: Db) => {
  const base = db.data.catalog.entries.find((e) => e.id === 'c-postgres');
  if (!base) throw new Error('fixture missing');
  db.data.catalog.entries.unshift({
    ...base,
    id: 'c-scratch',
    slug: 'scratch',
    displayName: 'Scratch server',
  });
  db.data.catalog.versions.push({
    ...versionOf(db, 'c-postgres'),
    id: 'v-scratch-1',
    entryId: 'c-scratch',
    label: '0.1.0',
    testResult: null,
  });
};

const withRun = (status: 'running' | 'failed', detail?: string) => (db: Db) => {
  const v = versionOf(db, 'c-postgres');
  v.testResult = {
    id: `run-${status}`,
    versionId: v.id,
    status,
    startedAt: iso(db.now),
    finishedAt: status === 'running' ? null : iso(db.now),
    steps: [
      { id: 'prepare', status: 'passed' },
      status === 'failed'
        ? { id: 'connect', status: 'failed', detail: detail ?? '' }
        : { id: 'connect', status: 'running' },
    ],
  } as typeof v.testResult;
};

const HINT = {
  unsaved: 'Save the draft and run its test to publish it.',
  changed: 'You changed this version since its last test. Save it and run the test again.',
  running: 'The test is running.',
  failed: 'The last test failed. Fix the problem and run the test again.',
  untested: 'Publish needs a passing test of this exact version. Run the test.',
};

const sideHint = (text: string) => {
  const card = screen.getByLabelText('Publish');
  expect(within(card).getByText(text)).toBeInTheDocument();
};

describe('Publish step blockers (11.3)', () => {
  it('11.3 a draft that was never saved says it is not saved or tested yet', async () => {
    await renderRoute('/catalog/new?step=publish');
    const panel = await screen.findByLabelText('Ready to publish');
    expect(panel).toHaveTextContent('This draft is not saved or tested yet.');
    expect(within(panel).getByText(HINT.unsaved)).toBeInTheDocument();
    sideHint(HINT.unsaved);
    expect(within(panel).getByRole('button', { name: /^Publish v/ })).toBeDisabled();
  });

  it('11.3 a saved draft without a test says it has not been tested', async () => {
    await renderRoute('/catalog/c-scratch?step=publish', { prepare: untestedDraft });
    const panel = await screen.findByLabelText('Ready to publish');
    await waitFor(() => expect(panel).toHaveTextContent('This version has not been tested.'));
    expect(within(panel).getByText(HINT.untested)).toBeInTheDocument();
    sideHint(HINT.untested);
  });

  it('11.3 a version edited after its test says it changed since the last test', async () => {
    const { user } = await renderRoute('/catalog/c-postgres?step=source');
    await screen.findByText('This version passed its test: it is ready to publish.');
    await user.type(screen.getByLabelText('Version'), '1');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Catalog steps' })).getByRole('button', {
        name: /Publish/,
      }),
    );
    const panel = await screen.findByLabelText('Ready to publish');
    expect(panel).toHaveTextContent('This version changed since its last test.');
    expect(within(panel).getByText(HINT.changed)).toBeInTheDocument();
    sideHint(HINT.changed);
  });

  it('11.3 a running test says it is still running', async () => {
    await renderRoute('/catalog/c-postgres?step=publish', { prepare: withRun('running') });
    const panel = await screen.findByLabelText('Ready to publish');
    await waitFor(() => expect(panel).toHaveTextContent('The test is still running.'));
    expect(within(panel).getByText(HINT.running)).toBeInTheDocument();
    sideHint(HINT.running);
  });

  it('11.3 a failed test names the first failing step and its first line of detail', async () => {
    await renderRoute('/catalog/c-postgres?step=publish', {
      prepare: withRun('failed', 'Connection refused\nsecond line'),
    });
    const panel = await screen.findByLabelText('Ready to publish');
    await waitFor(() => expect(panel).toHaveTextContent('The last test failed: '));
    expect(panel).toHaveTextContent(/The last test failed: .*: Connection refused/);
    expect(panel).not.toHaveTextContent('second line');
    expect(within(panel).getByText(HINT.failed)).toBeInTheDocument();
    sideHint(HINT.failed);
  });

  it('11.3 a failed step without detail reads as failed', async () => {
    await renderRoute('/catalog/c-postgres?step=publish', { prepare: withRun('failed', '') });
    const panel = await screen.findByLabelText('Ready to publish');
    await waitFor(() => expect(panel).toHaveTextContent(/The last test failed: .*: failed/));
  });
});
