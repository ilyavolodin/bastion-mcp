import { describe, expect, it } from 'vitest';
import {
  aggregateTestReport,
  claudeValidatePlan,
  claudeValidateResult,
  collectOsvPackages,
  listDependencyFiles,
  listTextFiles,
  runOsvStep,
  type TestStepResult,
  textFile,
} from '../src';

const pass = (id: TestStepResult['id']): TestStepResult => ({
  id,
  status: 'passed',
  summary: '',
  findings: [],
});

describe('25.3 test step', () => {
  it('25.3 builds the claude plugin validate command plan for a sandbox (no network)', () => {
    const plan = claudeValidatePlan({
      claudeFiles: [textFile('.claude-plugin/plugin.json', '{}')],
      pluginDirName: 'my-plugin',
    });
    expect(plan).toMatchObject({
      command: 'claude',
      args: ['plugin', 'validate', './my-plugin'],
      network: 'none',
      timeoutMs: 120_000,
    });
    expect(plan.files[0]?.path).toBe('my-plugin/.claude-plugin/plugin.json');
    expect(
      claudeValidatePlan({ claudeFiles: [], pluginDirName: 'x', timeoutMs: 5 }).timeoutMs,
    ).toBe(5);
  });

  it('25.3 maps the validate exit code to a step', () => {
    expect(claudeValidateResult({ exitCode: 0, stdout: 'ok', stderr: '' }).status).toBe('passed');
    const failed = claudeValidateResult({ exitCode: 1, stdout: '', stderr: 'bad manifest' });
    expect(failed).toMatchObject({ status: 'failed', findings: [{ message: 'bad manifest' }] });
    expect(claudeValidateResult({ exitCode: 2, stdout: '', stderr: '' }).findings).toEqual([]);
  });

  it('25.3 aggregates results: all required steps must run and pass', () => {
    const all = (
      ['claude-validate', 'agent-plugins-schema', 'guards', 'osv', 'classification'] as const
    ).map(pass);
    expect(aggregateTestReport(all)).toMatchObject({ passed: true, missing: [] });
    expect(aggregateTestReport(all.slice(1))).toMatchObject({
      passed: false,
      missing: ['claude-validate'],
    });
    const failing = [...all.slice(1), { ...pass('claude-validate'), status: 'failed' as const }];
    expect(aggregateTestReport(failing).passed).toBe(false);
    const skipped = [...all.slice(1), { ...pass('claude-validate'), status: 'skipped' as const }];
    expect(aggregateTestReport(skipped).passed).toBe(false);
  });

  it('13.6 lists the text files for definition-phase guard scans (UTF-8, no NUL)', () => {
    const files = [
      textFile('a.md', 'hello'),
      { path: 'bin.dat', content: new Uint8Array([0, 1, 2]), mode: 'file' as const },
      { path: 'bad.txt', content: new Uint8Array([0xff, 0xfe, 0xfd]), mode: 'file' as const },
    ];
    expect(listTextFiles(files)).toEqual([{ path: 'a.md', text: 'hello' }]);
  });
});

describe('25.3 OSV check inputs', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'root' },
      'node_modules/left-pad': { version: '1.3.0' },
      'node_modules/a/node_modules/@scope/b': { version: '2.0.0' },
      'node_modules/linked': { link: true },
    },
  });

  it('25.3 finds package.json, lockfiles and requirements files (not node_modules)', () => {
    const files = [
      'package.json',
      'x/package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'requirements.txt',
      'requirements-dev.txt',
      'node_modules/p/package.json',
      'README.md',
    ].map((p) => textFile(p, ''));
    expect(listDependencyFiles(files).map((f) => f.path)).toEqual([
      'package.json',
      'x/package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'requirements.txt',
      'requirements-dev.txt',
    ]);
  });

  it('25.3 extracts exact packages from every supported format', () => {
    const packages = collectOsvPackages([
      textFile('package-lock.json', lock),
      textFile(
        'package.json',
        JSON.stringify({
          dependencies: { pinned: '1.0.0', ranged: '^1.0.0' },
          devDependencies: { dev: '2.0.0-rc.1' },
        }),
      ),
      textFile(
        'requirements.txt',
        '# c\nrequests==2.31.0 ; python_version>"3"\nflask[async]==3.0.0\nloose>=1\n',
      ),
      textFile(
        'yarn.lock',
        '"@s/y@^1.0.0", "@s/y@^1.1.0":\n  version "1.2.0"\n\nplain@^2:\n  version "2.0.1"\n',
      ),
      textFile(
        'pnpm-lock.yaml',
        "packages:\n  /old@1.0.0:\n    resolution: {}\n  '@sc/new@3.1.0(react@18.0.0)':\n    resolution: {}\n",
      ),
      textFile(
        'v1/package-lock.json',
        JSON.stringify({
          dependencies: {
            v1dep: { version: '1.1.1', dependencies: { nested: { version: '0.0.1' } } },
          },
        }),
      ),
      textFile('bad/package.json', '{nope'),
    ]);
    const names = packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'npm:left-pad@1.3.0',
        'npm:@scope/b@2.0.0',
        'npm:pinned@1.0.0',
        'npm:dev@2.0.0-rc.1',
        'PyPI:requests@2.31.0',
        'PyPI:flask@3.0.0',
        'npm:@s/y@1.2.0',
        'npm:plain@2.0.1',
        'npm:old@1.0.0',
        'npm:@sc/new@3.1.0',
        'npm:v1dep@1.1.1',
        'npm:nested@0.0.1',
      ]),
    );
    expect(names).not.toContain('npm:ranged@^1.0.0');
    expect(names.some((n) => n.includes('loose'))).toBe(false);
  });

  const osvResponse =
    (vulns: ({ id: string }[] | undefined)[]): typeof fetch =>
    async () =>
      new Response(JSON.stringify({ results: vulns.map((v) => (v ? { vulns: v } : {})) }), {
        status: 200,
      });

  it('25.3 passes when there are no dependency files without calling OSV', async () => {
    const step = await runOsvStep([textFile('a.md', 'x')], {
      fetch: async () => {
        throw new Error('no network');
      },
    });
    expect(step).toMatchObject({ id: 'osv', status: 'passed' });
  });

  it('25.3 fails the step on known-malicious (MAL-) advisories, not on ordinary CVEs', async () => {
    const files = [textFile('requirements.txt', 'evil==1.0.0\nok==2.0.0\n')];
    const bad = await runOsvStep(files, {
      fetch: osvResponse([[{ id: 'MAL-2024-1' }], [{ id: 'GHSA-xxxx' }]]),
    });
    expect(bad.status).toBe('failed');
    expect(bad.findings[0]?.message).toContain('evil@1.0.0');
    const good = await runOsvStep(files, {
      fetch: osvResponse([undefined, [{ id: 'GHSA-xxxx' }]]),
    });
    expect(good.status).toBe('passed');
  });

  it('25.3 fails closed when OSV is unreachable', async () => {
    const step = await runOsvStep([textFile('requirements.txt', 'a==1.0\n')], {
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(step).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('could not complete'),
    });
  });
});
