import { createHash } from 'node:crypto';
import {
  checkPackagesAgainstOsv,
  type FetchFn,
  findMaliciousAdvisories,
  type OsvPackage,
  type OsvPackageResult,
  type PackageSpec,
} from '@bastion-mcp/core';
import { z } from 'zod';

/** Package supply chain (8.7): exact versions, lockfile capture, integrity, OSV check, `broken` marking. */

export type Lockfile = NonNullable<PackageSpec['lockfile']>;
export type LockfileKind = Lockfile['kind'];

export class SupplyChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplyChainError';
  }
}

// --- exact versions ---------------------------------------------------------------------------------------------
// Mirrors the regex of `packageSpec.version` in core/server-spec.ts (not exported there).
const EXACT_VERSION = /^\d+(?:\.\d+)+(?:[-+._]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;

/** True for semver and PEP 440 exact versions; ranges, tags and `latest` are rejected (8.7). */
export const isExactVersion = (version: string): boolean => EXACT_VERSION.test(version);

export const validateExactVersion = (version: string): string => {
  if (!isExactVersion(version)) {
    throw new SupplyChainError(`"${version}" is not an exact version (ranges, tags and latest are rejected)`);
  }
  return version;
};

// --- integrity ----------------------------------------------------------------------------------------------------
export const sha256Hex = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

export const lockfileSha256 = sha256Hex;

export const verifyLockfileIntegrity = (lockfile: Lockfile): boolean =>
  sha256Hex(lockfile.content) === lockfile.sha256;

export const assertLockfileIntegrity = (lockfile: Lockfile): void => {
  if (!verifyLockfileIntegrity(lockfile)) {
    throw new SupplyChainError('lockfile content does not match its recorded sha256');
  }
};

// --- capture plans ------------------------------------------------------------------------------------------------
export type CapturePlan = {
  kind: LockfileKind;
  /** Files to write into the one-off sandbox before running the command. */
  files: { path: string; content: string }[];
  command: { command: string; args: string[] };
  /** File the command produces; its content is the lockfile. */
  outputFile: string;
  /** Install scripts never run while resolving (8.7). */
  env: Record<string, string>;
};

/** One-off sandbox plan that resolves the dependency tree for an admin-tested catalog entry (8.7). */
export const buildLockfileCapturePlan = (
  spec: Pick<PackageSpec, 'runtime' | 'identifier' | 'version'>,
  root = '/opt/mcp',
): CapturePlan => {
  validateExactVersion(spec.version);
  if (spec.runtime === 'npm') {
    return {
      kind: 'npm-shrinkwrap',
      files: [
        {
          path: 'package.json',
          content: JSON.stringify(
            {
              name: 'bastion-mcp-instance',
              version: '0.0.0',
              private: true,
              dependencies: { [spec.identifier]: spec.version },
            },
            null,
            2,
          ),
        },
      ],
      command: {
        command: 'npm',
        args: [
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--prefix',
          root,
        ],
      },
      outputFile: 'package-lock.json',
      env: {},
    };
  }
  return {
    kind: 'uv-requirements',
    files: [{ path: 'requirements.in', content: `${spec.identifier}==${spec.version}\n` }],
    command: {
      command: 'uv',
      args: [
        'pip',
        'compile',
        '--generate-hashes',
        '--no-header',
        `${root}/requirements.in`,
        '-o',
        `${root}/requirements.txt`,
      ],
    },
    outputFile: 'requirements.txt',
    env: {},
  };
};

/** Wraps the captured file content with its SHA-256, ready to store on the catalog version. */
export const lockfileFromCapture = (plan: CapturePlan, content: string): Lockfile => ({
  kind: plan.kind,
  content,
  sha256: sha256Hex(content),
});

// --- pinned package extraction ---------------------------------------------------------------------------------
const npmLockSchema = z.object({
  packages: z
    .record(
      z.string(),
      z.object({ version: z.string().optional(), link: z.boolean().optional() }).passthrough(),
    )
    .optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
});

type LegacyDependency = { version?: unknown; dependencies?: Record<string, unknown> };

const collectLegacy = (deps: Record<string, unknown>, out: Map<string, OsvPackage>): void => {
  for (const [name, raw] of Object.entries(deps)) {
    const dep = raw as LegacyDependency;
    if (typeof dep.version === 'string' && isExactVersion(dep.version)) {
      out.set(`${name}@${dep.version}`, { ecosystem: 'npm', name, version: dep.version });
    }
    if (dep.dependencies) collectLegacy(dep.dependencies, out);
  }
};

export const extractNpmPackages = (content: string): OsvPackage[] => {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new SupplyChainError('npm lockfile is not valid JSON');
  }
  const parsed = npmLockSchema.safeParse(json);
  if (!parsed.success) throw new SupplyChainError('npm lockfile has an unexpected shape');
  const out = new Map<string, OsvPackage>();
  for (const [key, entry] of Object.entries(parsed.data.packages ?? {})) {
    if (key === '' || entry.link || !entry.version) continue;
    const marker = key.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const name = key.slice(marker + 'node_modules/'.length);
    out.set(`${name}@${entry.version}`, { ecosystem: 'npm', name, version: entry.version });
  }
  if (parsed.data.dependencies) collectLegacy(parsed.data.dependencies, out);
  return [...out.values()];
};

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;\\]+)/;

export type ParsedRequirement = { name: string; version: string; hashes: string[] };

/** Parses a `uv pip compile --generate-hashes` file: `name==version \` plus `--hash=sha256:...` lines. */
export const parseRequirements = (content: string): ParsedRequirement[] => {
  const out: ParsedRequirement[] = [];
  let current: ParsedRequirement | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const hash = /^--hash=(sha256:[0-9a-f]{64})/.exec(line);
    if (hash && current) {
      current.hashes.push(hash[1] as string);
      continue;
    }
    if (line.startsWith('-')) continue;
    const match = REQUIREMENT.exec(line);
    if (!match) throw new SupplyChainError(`requirements line is not pinned with ==: "${line.slice(0, 80)}"`);
    current = { name: match[1] as string, version: match[2] as string, hashes: [] };
    for (const inlineHash of line.matchAll(/--hash=(sha256:[0-9a-f]{64})/g)) {
      current.hashes.push(inlineHash[1] as string);
    }
    out.push(current);
  }
  return out;
};

export const extractPypiPackages = (content: string): OsvPackage[] =>
  parseRequirements(content).map((r) => ({
    ecosystem: 'PyPI' as const,
    name: r.name.toLowerCase().replace(/[_.]+/g, '-'),
    version: r.version,
  }));

/** Every pinned package of the lockfile. */
export const extractPinnedPackages = (lockfile: Lockfile): OsvPackage[] =>
  lockfile.kind === 'npm-shrinkwrap'
    ? extractNpmPackages(lockfile.content)
    : extractPypiPackages(lockfile.content);

/** `--require-hashes` fails on any requirement without a hash; catch it at capture time (8.7). */
export const assertAllRequirementsHashed = (content: string): void => {
  const missing = parseRequirements(content).filter((r) => r.hashes.length === 0);
  if (missing.length > 0) {
    throw new SupplyChainError(`requirements without hashes: ${missing.map((m) => m.name).join(', ')}`);
  }
};

export type LockfileCheck = {
  packages: OsvPackage[];
  /** Packages with `MAL-` advisories; empty when the OSV check is disabled or clean. */
  malicious: OsvPackageResult[];
  osvChecked: boolean;
  ok: boolean;
};

/**
 * Integrity, pinned-package extraction and (when `BASTION_OSV_CHECK=true`) the OSV malicious-package check
 * (8.7). OSV failures throw (fail closed) rather than passing silently.
 */
export const checkLockfile = async (
  lockfile: Lockfile,
  options: { osvCheck: boolean; fetch?: FetchFn; osvBaseUrl?: string; timeoutMs?: number } = {
    osvCheck: false,
  },
): Promise<LockfileCheck> => {
  assertLockfileIntegrity(lockfile);
  const packages = extractPinnedPackages(lockfile);
  if (lockfile.kind === 'uv-requirements') assertAllRequirementsHashed(lockfile.content);
  if (!options.osvCheck) return { packages, malicious: [], osvChecked: false, ok: true };
  const results = await checkPackagesAgainstOsv(packages, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.osvBaseUrl ? { baseUrl: options.osvBaseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const malicious = findMaliciousAdvisories(results);
  return { packages, malicious, osvChecked: true, ok: malicious.length === 0 };
};

// --- broken marking ---------------------------------------------------------------------------------------------
export type InstallOutcome = {
  hasLockfile: boolean;
  succeeded: boolean;
  /** Phase from the runner's NDJSON stream at failure. */
  failedPhase?: 'installing' | 'starting' | 'connecting' | string;
};

/**
 * A lockfile that no longer installs marks the catalog version `broken` instead of silently re-resolving
 * (8.7). Failures after the install step (spawn, connect) are instance failures, not lockfile failures.
 */
export const shouldMarkBroken = (outcome: InstallOutcome): boolean =>
  outcome.hasLockfile && !outcome.succeeded && outcome.failedPhase === 'installing';

/** Never re-resolve: without a lockfile the runner may install `identifier@version` only where policy allows. */
export const mayInstallWithoutLockfile = (policy: { allowUnlockedInstalls: boolean }): boolean =>
  policy.allowUnlockedInstalls;
