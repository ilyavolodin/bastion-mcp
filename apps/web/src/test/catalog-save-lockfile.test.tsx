import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { getDb } from '@/mocks/db';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * Saving a draft version (11.2, 8.7): the test stores the lockfile it captured on the draft's spec. The form does not
 * edit it, so it is carried over while the package and its version are the same, and never makes the spec look
 * edited. The editor's draft already carries it, so even a new package or version sends it (pinned). The version is patched only when label, spec or install form changed.
 */

type Db = ReturnType<typeof getDb>;
type Sent = { label: string; serverSpec: Record<string, unknown> };

const LOCK = { kind: 'npm-shrinkwrap', content: '{}', sha256: 'a'.repeat(64) };

const withLockfile = (db: Db) => {
  const v = db.data.catalog.versions.find((x) => x.entryId === 'c-postgres');
  if (!v?.serverSpec) throw new Error('fixture missing');
  (v.serverSpec as Record<string, unknown>).lockfile = LOCK;
};

const versionPatches = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method === 'patch' && /\/versions\/[^/]+$/.test(c.path));

describe('Saving a draft version carries the stored lockfile (11.2)', () => {
  it('11.2 a save that changes nothing in the version sends no version patch, lockfile or not', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres', { prepare: withLockfile });
    const name = await screen.findByLabelText(/Display name/);
    await user.type(name, '!');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await expectSent(capture, 'patch', '/catalog/c-postgres');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled());
    expect(versionPatches(capture.calls)).toEqual([]);
    capture.stop();
  });

  it('11.2 a changed label keeps the stored lockfile in the patched spec', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres', { prepare: withLockfile });
    const label = await screen.findByLabelText('Version label');
    await user.clear(label);
    await user.type(label, '3.2.1');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const sent = (await expectSent(
      capture,
      'patch',
      /\/catalog\/c-postgres\/versions\/[^/]+$/,
    )) as Sent;
    expect(sent.label).toBe('3.2.1');
    expect(sent.serverSpec.lockfile).toEqual(LOCK);
    capture.stop();
  });

  it('11.2 a changed package still sends the stored lockfile: the editor draft carries it', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres?step=source', {
      prepare: withLockfile,
    });
    const pkg = await screen.findByLabelText('Package');
    await user.type(pkg, '-next');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const sent = (await expectSent(
      capture,
      'patch',
      /\/catalog\/c-postgres\/versions\/[^/]+$/,
    )) as Sent;
    expect(sent.serverSpec.identifier).toMatch(/-next$/);
    expect(sent.serverSpec.lockfile).toEqual(LOCK);
    capture.stop();
  });

  it('11.2 a changed package version still sends the stored lockfile: the editor draft carries it', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres?step=source', {
      prepare: withLockfile,
    });
    const version = await screen.findByLabelText('Version');
    await user.type(version, '1');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const sent = (await expectSent(
      capture,
      'patch',
      /\/catalog\/c-postgres\/versions\/[^/]+$/,
    )) as Sent;
    expect(sent.serverSpec.lockfile).toEqual(LOCK);
    capture.stop();
  });
});
