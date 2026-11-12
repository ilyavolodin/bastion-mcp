import { describe, expect, it } from 'vitest';
import type { CatalogVersion } from '@/api/views/catalog';
import {
  sameJson,
  type VersionCreateBody,
  versionChanged,
  withStoredLockfile,
} from '@/features/catalog/draft';

const LOCK = { kind: 'npm-shrinkwrap', content: '{}', sha256: 'a'.repeat(64) };
const body = (spec: Record<string, unknown> | undefined): VersionCreateBody =>
  ({
    label: '1.0.0',
    serverSpec: spec,
    installForm: { variables: [], secrets: [] },
    changelog: null,
  }) as unknown as VersionCreateBody;
const pkg = { type: 'package', identifier: 'pkg', version: '1.0.0' };

describe('withStoredLockfile (11.2, 8.7)', () => {
  it('11.2 carries the stored lockfile over when identifier and version are unchanged', () => {
    const input = body(pkg);
    const out = withStoredLockfile(input, { ...pkg, lockfile: LOCK });
    expect(out.serverSpec).toEqual({ ...pkg, lockfile: LOCK });
    expect(input.serverSpec).toEqual(pkg);
  });

  it('11.2 drops it for a new identifier or a new version', () => {
    expect(
      withStoredLockfile(body(pkg), { ...pkg, identifier: 'other', lockfile: LOCK }).serverSpec,
    ).toEqual(pkg);
    expect(
      withStoredLockfile(body(pkg), { ...pkg, version: '2.0.0', lockfile: LOCK }).serverSpec,
    ).toEqual(pkg);
  });

  it('11.2 keeps the lockfile the body already has, and adds none when nothing is stored', () => {
    const own = { ...pkg, lockfile: { ...LOCK, content: 'own' } };
    expect(withStoredLockfile(body(own), { ...pkg, lockfile: LOCK }).serverSpec).toEqual(own);
    expect(withStoredLockfile(body(pkg), pkg).serverSpec).toEqual(pkg);
  });

  it('11.2 leaves a body without a spec alone', () => {
    expect(
      withStoredLockfile(body(undefined), { ...pkg, lockfile: LOCK }).serverSpec,
    ).toBeUndefined();
  });
});

describe('versionChanged (11.2)', () => {
  const stored = {
    label: '1.0.0',
    serverSpec: { b: 1, a: { y: 1, x: 2 } },
    installForm: { variables: [], secrets: [] },
  } as unknown as CatalogVersion;
  const same = () => body({ a: { x: 2, y: 1 }, b: 1 });

  it('11.2 is false when label, spec (ignoring key order) and form are the same', () => {
    expect(versionChanged(stored, same())).toBe(false);
  });

  it('11.2 is true for a new label, a new spec or a new install form', () => {
    expect(versionChanged(stored, { ...same(), label: '1.0.1' })).toBe(true);
    expect(versionChanged(stored, body({ a: 1 }))).toBe(true);
    expect(
      versionChanged(stored, {
        ...same(),
        installForm: { variables: [{ name: 'x' }], secrets: [] },
      } as unknown as VersionCreateBody),
    ).toBe(true);
  });
});

describe('sameJson', () => {
  it('ignores key order', () => {
    expect(sameJson({ a: 1, b: [{ c: 1, d: 2 }] }, { b: [{ d: 2, c: 1 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });
});
