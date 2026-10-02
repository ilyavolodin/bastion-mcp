import {
  checkPackagesAgainstOsv,
  type FetchFn,
  findMaliciousAdvisories,
  type OsvPackage,
} from '@bastion-mcp/core';
import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseYaml } from 'yaml';
import { type ClassifiedFile, classifyFiles } from './classify';
import { AGENT_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA } from './schemas';
import { decodeUtf8, type PluginFile } from './types';

export type TestStepId =
  | 'claude-validate'
  | 'agent-plugins-schema'
  | 'guards'
  | 'osv'
  | 'classification';

export type Finding = { path?: string; message: string };

export type TestStepResult = {
  id: TestStepId;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
  findings: Finding[];
  /** Classification step: the list shown to the approver (25.3). */
  classification?: ClassifiedFile[];
};

export type TestReport = {
  passed: boolean;
  steps: TestStepResult[];
  /** Required steps that never ran. */
  missing: TestStepId[];
};

/** Steps that must pass before publish (25.3). Classification only informs the approver. */
export const REQUIRED_TEST_STEPS: readonly TestStepId[] = [
  'claude-validate',
  'agent-plugins-schema',
  'guards',
  'osv',
  'classification',
];

/** Aggregates step results: passed when every required step ran and none failed or was skipped. */
export const aggregateTestReport = (steps: readonly TestStepResult[]): TestReport => {
  const ran = new Set(steps.map((s) => s.id));
  const missing = REQUIRED_TEST_STEPS.filter((id) => !ran.has(id));
  const blocking = steps.some((s) => s.status !== 'passed');
  return { passed: missing.length === 0 && !blocking, steps: [...steps], missing };
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatePlugin: ValidateFunction = ajv.compile(AGENT_PLUGIN_SCHEMA);
const validateMcp: ValidateFunction = ajv.compile(AGENT_MCP_SCHEMA);

const checkJson = (
  file: PluginFile | undefined,
  validate: typeof validatePlugin,
  findings: Finding[],
): void => {
  if (!file) return;
  const text = decodeUtf8(file.content);
  let data: unknown;
  try {
    data = text === undefined ? undefined : JSON.parse(text);
  } catch {
    findings.push({ path: file.path, message: 'not valid JSON' });
    return;
  }
  if (!validate(data)) {
    for (const e of validate.errors ?? []) {
      findings.push({
        path: file.path,
        message: `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      });
    }
  }
};

/**
 * JSON Schema validation of the Agent Plugins rendering of one plugin (25.3), offline against the
 * vendored schemas of `schemas.ts`. `files` are paths relative to the plugin root.
 */
export const validateAgentPluginsRendering = (files: readonly PluginFile[]): TestStepResult => {
  const findings: Finding[] = [];
  const manifest = files.find((f) => f.path === 'plugin.json');
  if (!manifest) findings.push({ message: 'plugin.json is missing' });
  checkJson(manifest, validatePlugin, findings);
  checkJson(
    files.find((f) => f.path === 'mcp.json'),
    validateMcp,
    findings,
  );
  return {
    id: 'agent-plugins-schema',
    status: findings.length === 0 ? 'passed' : 'failed',
    summary:
      findings.length === 0
        ? 'plugin.json and mcp.json match the schemas'
        : `${findings.length} schema errors`,
    findings,
  };
};

export type SandboxCommandPlan = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** The api layer runs it in the sandbox image that adds the pinned `@anthropic-ai/claude-code`. */
  network: 'none';
  /** Paths to materialize before the run (the Claude rendering, relative to `cwd`). */
  files: PluginFile[];
};

/** The `claude plugin validate` invocation for the Claude rendering (25.3); the api layer runs it. */
export const claudeValidatePlan = (input: {
  claudeFiles: readonly PluginFile[];
  pluginDirName: string;
  timeoutMs?: number;
}): SandboxCommandPlan => ({
  command: 'claude',
  args: ['plugin', 'validate', `./${input.pluginDirName}`],
  cwd: '/work',
  timeoutMs: input.timeoutMs ?? 120_000,
  network: 'none',
  files: input.claudeFiles.map((f) => ({ ...f, path: `${input.pluginDirName}/${f.path}` })),
});

/** Maps the sandbox result of `claude plugin validate` to a step. */
export const claudeValidateResult = (run: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): TestStepResult => {
  const ok = run.exitCode === 0;
  const output = `${run.stdout}\n${run.stderr}`.trim();
  return {
    id: 'claude-validate',
    status: ok ? 'passed' : 'failed',
    summary: ok ? 'claude plugin validate passed' : `claude plugin validate exited ${run.exitCode}`,
    findings: ok || output === '' ? [] : [{ message: output.slice(0, 4000) }],
  };
};

/** Text files for the definition-phase guard scans (13.6, 25.3): valid UTF-8 without NUL bytes. */
export const listTextFiles = (files: readonly PluginFile[]): { path: string; text: string }[] => {
  const out: { path: string; text: string }[] = [];
  for (const file of files) {
    if (file.content.includes(0)) continue;
    const text = decodeUtf8(file.content);
    if (text !== undefined) out.push({ path: file.path, text });
  }
  return out;
};

const DEP_FILE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|requirements[^/]*\.txt)$/;

/** `package.json`, lockfiles and `requirements*.txt` for the OSV check (25.3). */
export const listDependencyFiles = (files: readonly PluginFile[]): PluginFile[] =>
  files.filter((f) => DEP_FILE.test(f.path) && !f.path.split('/').includes('node_modules'));

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const fromPackageLock = (data: unknown): OsvPackage[] => {
  const out: OsvPackage[] = [];
  const lock = data as {
    packages?: Record<string, { version?: string; link?: boolean }>;
    dependencies?: Record<string, { version?: string; dependencies?: unknown }>;
  };
  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    const idx = key.lastIndexOf('node_modules/');
    if (idx < 0 || info.link || !info.version) continue;
    out.push({
      ecosystem: 'npm',
      name: key.slice(idx + 'node_modules/'.length),
      version: info.version,
    });
  }
  const walk = (
    deps: Record<string, { version?: string; dependencies?: unknown }> | undefined,
  ): void => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (info.version && EXACT.test(info.version))
        out.push({ ecosystem: 'npm', name, version: info.version });
      walk(info.dependencies as typeof deps);
    }
  };
  if (!lock.packages) walk(lock.dependencies);
  return out;
};

const fromPackageJson = (data: unknown): OsvPackage[] => {
  const out: OsvPackage[] = [];
  const pkg = data as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string' && EXACT.test(range))
        out.push({ ecosystem: 'npm', name, version: range });
    }
  }
  return out;
};

const fromRequirements = (text: string): OsvPackage[] => {
  const out: OsvPackage[] = [];
  for (const raw of text.split('\n')) {
    const line = (raw.split('#')[0] ?? '').split(';')[0]?.trim() ?? '';
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)$/.exec(line);
    if (m?.[1] && m[2]) out.push({ ecosystem: 'PyPI', name: m[1], version: m[2] });
  }
  return out;
};

const fromYarnLock = (text: string): OsvPackage[] => {
  const out: OsvPackage[] = [];
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\S.*:$/.test(line) && !line.startsWith('#')) {
      names = line
        .slice(0, -1)
        .split(',')
        .map((s) =>
          s
            .trim()
            .replace(/^"|"$/g, '')
            .replace(/@[^@]*$/, ''),
        )
        .filter(Boolean);
    } else {
      const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (v?.[1] && names[0]) out.push({ ecosystem: 'npm', name: names[0], version: v[1] });
    }
  }
  return out;
};

const fromPnpmLock = (text: string): OsvPackage[] => {
  const data = parseYaml(text) as { packages?: Record<string, unknown> } | null;
  const out: OsvPackage[] = [];
  for (const key of Object.keys(data?.packages ?? {})) {
    const m = /^\/?((?:@[^/@]+\/)?[^/@]+)[@/](\d+\.\d+\.\d+[^(\s]*)/.exec(key);
    if (m?.[1] && m[2]) out.push({ ecosystem: 'npm', name: m[1], version: m[2] });
  }
  return out;
};

/** Packages declared by the dependency files of a plugin, deduplicated and sorted. */
export const collectOsvPackages = (files: readonly PluginFile[]): OsvPackage[] => {
  const found = new Map<string, OsvPackage>();
  for (const file of listDependencyFiles(files)) {
    const text = decodeUtf8(file.content);
    if (text === undefined) continue;
    const base = file.path.split('/').at(-1) ?? '';
    let packages: OsvPackage[] = [];
    try {
      if (base === 'package.json') packages = fromPackageJson(JSON.parse(text));
      else if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
        packages = fromPackageLock(JSON.parse(text));
      } else if (base === 'yarn.lock') packages = fromYarnLock(text);
      else if (base === 'pnpm-lock.yaml') packages = fromPnpmLock(text);
      else if (base.startsWith('requirements')) packages = fromRequirements(text);
    } catch {
      // An unparsable dependency file contributes nothing; the guards scan still sees its text.
    }
    for (const p of packages) found.set(`${p.ecosystem}:${p.name}@${p.version}`, p);
  }
  return [...found.values()].sort((a, b) =>
    `${a.ecosystem}:${a.name}@${a.version}` < `${b.ecosystem}:${b.name}@${b.version}` ? -1 : 1,
  );
};

/** OSV check of a plugin's dependency files (25.3); known-malicious advisories fail the step. */
export const runOsvStep = async (
  files: readonly PluginFile[],
  options: { fetch?: FetchFn } = {},
): Promise<TestStepResult> => {
  const packages = collectOsvPackages(files);
  if (packages.length === 0) {
    return { id: 'osv', status: 'passed', summary: 'no dependency files', findings: [] };
  }
  try {
    const results = await checkPackagesAgainstOsv(
      packages,
      options.fetch ? { fetch: options.fetch } : {},
    );
    const bad = findMaliciousAdvisories(results);
    return {
      id: 'osv',
      status: bad.length === 0 ? 'passed' : 'failed',
      summary:
        bad.length === 0
          ? `${packages.length} packages checked`
          : `${bad.length} malicious packages`,
      findings: bad.map((r) => ({
        message: `${r.package.name}@${r.package.version}: ${r.advisoryIds.join(', ')}`,
      })),
    };
  } catch (error) {
    return {
      id: 'osv',
      status: 'failed',
      summary: 'OSV check could not complete',
      findings: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
};

/** The classification step: informational for the approver, never failing (25.3). */
export const classificationStep = (files: readonly PluginFile[]): TestStepResult => {
  const classification = classifyFiles(files);
  const executable = classification.filter((c) => c.classification === 'executable');
  return {
    id: 'classification',
    status: 'passed',
    summary:
      executable.length === 0
        ? 'plain: no executable content'
        : `${executable.length} executable files need Admin approval`,
    findings: executable.map((c) => ({ path: c.path, message: c.reason })),
    classification,
  };
};
