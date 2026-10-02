import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertAllRequirementsHashed,
  buildLockfileCapturePlan,
  checkLockfile,
  extractNpmPackages,
  extractPinnedPackages,
  isExactVersion,
  lockfileFromCapture,
  mayInstallWithoutLockfile,
  parseRequirements,
  sha256Hex,
  shouldMarkBroken,
  validateExactVersion,
  verifyLockfileIntegrity,
} from '../src/supply-chain';

const H = `sha256:${'a'.repeat(64)}`;
const REQS = `# comment
mcp-server-fetch==2025.4.7 \\
    --hash=${H} \\
    --hash=sha256:${'b'.repeat(64)}
    # via foo
Some_Pkg[extra]==1.0.0 \\
    --hash=${H}
`;
const SHRINKWRAP = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'root', version: '0.0.0' },
    'node_modules/@scope/server-x': { version: '1.2.3' },
    'node_modules/a': { version: '2.0.0' },
    'node_modules/a/node_modules/b': { version: '3.1.0' },
    'node_modules/linked': { link: true, version: '9.9.9' },
  },
});

describe('8.7 exact versions', () => {
  it.each(['1.2.3', '0.1.0-beta.1', '2025.4.7', '1.0.0rc1', '1.2.3+build.5'])('accepts %s', (v) => {
    expect(isExactVersion(v)).toBe(true);
    expect(validateExactVersion(v)).toBe(v);
  });
  it.each(['latest', '^1.2.3', '~1.2', '>=1.0', '1.x', '*', '1', '', '1.2.3 - 2.0.0', 'next'])(
    '8.7 rejects %s',
    (v) => {
      expect(isExactVersion(v)).toBe(false);
      expect(() => validateExactVersion(v)).toThrow(/exact version/);
    },
  );
  it('8.7 property: range operators are never exact', () => {
    fc.assert(
      fc.property(fc.constantFrom('^', '~', '>', '<', '>=', '<=', '*'), fc.nat(9), (op, n) => {
        expect(isExactVersion(`${op}${n}.0.0`)).toBe(false);
      }),
    );
  });
});

describe('8.7 lockfile capture plans', () => {
  it('8.7 npm: npm install --package-lock-only with scripts off', () => {
    const plan = buildLockfileCapturePlan({ runtime: 'npm', identifier: '@s/x', version: '1.0.0' });
    expect(plan.command.command).toBe('npm');
    expect(plan.command.args).toEqual(
      expect.arrayContaining(['install', '--package-lock-only', '--ignore-scripts']),
    );
    expect(plan.outputFile).toBe('package-lock.json');
    expect(JSON.parse(plan.files[0]?.content ?? '{}').dependencies).toEqual({ '@s/x': '1.0.0' });
    expect(plan.kind).toBe('npm-shrinkwrap');
  });
  it('8.7 pypi: uv pip compile --generate-hashes', () => {
    const plan = buildLockfileCapturePlan({
      runtime: 'pypi',
      identifier: 'mcp-server-fetch',
      version: '1.0',
    });
    expect(plan.command.args).toEqual(
      expect.arrayContaining(['pip', 'compile', '--generate-hashes']),
    );
    expect(plan.files[0]).toEqual({ path: 'requirements.in', content: 'mcp-server-fetch==1.0\n' });
    expect(plan.kind).toBe('uv-requirements');
  });
  it('8.7 refuses to plan a capture for a range', () => {
    expect(() =>
      buildLockfileCapturePlan({ runtime: 'npm', identifier: 'x', version: '^1.0.0' }),
    ).toThrow();
  });
  it('8.7 the captured content is stored with its sha256 and verifies', () => {
    const plan = buildLockfileCapturePlan({ runtime: 'npm', identifier: 'x', version: '1.0.0' });
    const lock = lockfileFromCapture(plan, SHRINKWRAP);
    expect(lock.sha256).toBe(sha256Hex(SHRINKWRAP));
    expect(verifyLockfileIntegrity(lock)).toBe(true);
    expect(verifyLockfileIntegrity({ ...lock, content: `${SHRINKWRAP} ` })).toBe(false);
  });
});

describe('8.7 pinned package extraction', () => {
  it('8.7 extracts npm packages from a shrinkwrap, skipping root and links', () => {
    expect(extractNpmPackages(SHRINKWRAP)).toEqual([
      { ecosystem: 'npm', name: '@scope/server-x', version: '1.2.3' },
      { ecosystem: 'npm', name: 'a', version: '2.0.0' },
      { ecosystem: 'npm', name: 'b', version: '3.1.0' },
    ]);
  });
  it('8.7 reads lockfileVersion 1 `dependencies` trees', () => {
    const v1 = JSON.stringify({
      dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } },
    });
    expect(extractNpmPackages(v1).map((p) => `${p.name}@${p.version}`)).toEqual([
      'a@1.0.0',
      'b@2.0.0',
    ]);
  });
  it('8.7 rejects a malformed npm lockfile', () => {
    expect(() => extractNpmPackages('nope')).toThrow(/JSON/);
    expect(() => extractNpmPackages('{"packages":[]}')).toThrow(/shape/);
  });
  it('8.7 parses uv requirements with hashes and continuations', () => {
    const parsed = parseRequirements(REQS);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: 'mcp-server-fetch', version: '2025.4.7' });
    expect(parsed[0]?.hashes).toHaveLength(2);
    expect(extractPinnedPackages({ kind: 'uv-requirements', content: REQS, sha256: '' })).toEqual([
      { ecosystem: 'PyPI', name: 'mcp-server-fetch', version: '2025.4.7' },
      { ecosystem: 'PyPI', name: 'some-pkg', version: '1.0.0' },
    ]);
  });
  it('8.7 an unpinned requirement is an error and unhashed ones are reported', () => {
    expect(() => parseRequirements('requests>=2')).toThrow(/pinned/);
    expect(() => assertAllRequirementsHashed('a==1.0\n')).toThrow(/hashes/);
    expect(() => assertAllRequirementsHashed(REQS)).not.toThrow();
    expect(parseRequirements(`a==1.0 --hash=${H}\n-i https://x\n`)[0]?.hashes).toEqual([H]);
  });
});

const osvFetch = (vulns: Record<string, string[]>) => async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { queries: { package: { name: string } }[] };
  return new Response(
    JSON.stringify({
      results: body.queries.map((q) => ({
        vulns: (vulns[q.package.name] ?? []).map((id) => ({ id })),
      })),
    }),
  );
};

describe('8.7 checkLockfile', () => {
  const lock = {
    kind: 'npm-shrinkwrap' as const,
    content: SHRINKWRAP,
    sha256: sha256Hex(SHRINKWRAP),
  };

  it('8.7 fails on an integrity mismatch before anything else', async () => {
    await expect(checkLockfile({ ...lock, sha256: 'f'.repeat(64) })).rejects.toThrow(/sha256/);
  });
  it('8.7 skips OSV when disabled', async () => {
    const result = await checkLockfile(lock, { osvCheck: false });
    expect(result).toMatchObject({ osvChecked: false, ok: true });
    expect(result.packages).toHaveLength(3);
  });
  it('8.7 rejects versions with MAL- advisories when BASTION_OSV_CHECK is on', async () => {
    const result = await checkLockfile(lock, {
      osvCheck: true,
      fetch: osvFetch({ a: ['MAL-2025-1', 'GHSA-xxxx'] }),
    });
    expect(result.ok).toBe(false);
    expect(result.malicious[0]?.advisoryIds).toEqual(['MAL-2025-1']);
  });
  it('8.7 ordinary CVEs do not block', async () => {
    const result = await checkLockfile(lock, {
      osvCheck: true,
      fetch: osvFetch({ a: ['GHSA-1'] }),
    });
    expect(result.ok).toBe(true);
    expect(result.osvChecked).toBe(true);
  });
  it('8.7 an OSV failure fails closed', async () => {
    await expect(
      checkLockfile(lock, {
        osvCheck: true,
        fetch: async () => new Response('x', { status: 500 }),
      }),
    ).rejects.toThrow(/OSV/);
  });
  it('8.7 uv lockfiles must carry hashes', async () => {
    const content = 'a==1.0\n';
    await expect(
      checkLockfile({ kind: 'uv-requirements', content, sha256: sha256Hex(content) }),
    ).rejects.toThrow(/hashes/);
  });
  it('8.7 checks pypi lockfiles', async () => {
    const result = await checkLockfile(
      { kind: 'uv-requirements', content: REQS, sha256: sha256Hex(REQS) },
      { osvCheck: true, fetch: osvFetch({ 'some-pkg': ['MAL-1'] }) },
    );
    expect(result.ok).toBe(false);
  });
});

describe('8.7 broken marking', () => {
  it('8.7 a lockfile that no longer installs marks the version broken', () => {
    expect(
      shouldMarkBroken({ hasLockfile: true, succeeded: false, failedPhase: 'installing' }),
    ).toBe(true);
  });
  it('8.7 spawn failures, successes and unlocked installs do not', () => {
    expect(shouldMarkBroken({ hasLockfile: true, succeeded: false, failedPhase: 'starting' })).toBe(
      false,
    );
    expect(shouldMarkBroken({ hasLockfile: true, succeeded: true })).toBe(false);
    expect(
      shouldMarkBroken({ hasLockfile: false, succeeded: false, failedPhase: 'installing' }),
    ).toBe(false);
  });
  it('8.7 unlocked installs only where policy allows', () => {
    expect(mayInstallWithoutLockfile({ allowUnlockedInstalls: false })).toBe(false);
    expect(mayInstallWithoutLockfile({ allowUnlockedInstalls: true })).toBe(true);
  });
});
