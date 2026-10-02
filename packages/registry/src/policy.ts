import {
  checkPackagesAgainstOsv,
  findMaliciousAdvisories,
  type OsvPackage,
  type OsvPackageResult,
  RISK_LEVELS,
  type ServerSpec,
} from '@bastion-mcp/core';
import picomatch from 'picomatch';
import { z } from 'zod';
import type { FetchFn, RegistryTrust } from './ports';

/** One-click install policy (11.7). Pure: the caller loads the policy and executes the decision. */

export type Risk = (typeof RISK_LEVELS)[number];

export const registryPolicySchema = z.object({
  allowedNamespaces: z.array(z.string().min(1)).default(['*']),
  blockedNamespaces: z.array(z.string().min(1)).default([]),
  allowedRuntimes: z.array(z.enum(['remote', 'npm', 'pypi'])).default(['remote']),
  whoMayInstall: z.enum(['admins', 'managers', 'everyone']).default('managers'),
  mode: z.enum(['direct', 'request', 'catalogOnly']).default('request'),
  requireOsvClean: z.boolean().default(true),
  maxRisk: z.enum(RISK_LEVELS).default('low'),
});
export type RegistryPolicy = z.infer<typeof registryPolicySchema>;

/** The secure defaults of 22.5: request mode, remote only, OSV on. */
export const DEFAULT_REGISTRY_POLICY: RegistryPolicy = registryPolicySchema.parse({});

export const parseRegistryPolicy = (input: unknown): RegistryPolicy =>
  registryPolicySchema.parse(input ?? {});

// --- Risk -----------------------------------------------------------------------------------------------------------

/** Registry-created entries take their risk from source trust (11.7). */
export const riskFromTrust = (trust: RegistryTrust): Risk =>
  trust === 'community' ? 'medium' : 'low';

const riskRank = (risk: Risk): number => RISK_LEVELS.indexOf(risk);

export const exceedsRisk = (risk: Risk, max: Risk): boolean => riskRank(risk) > riskRank(max);

// --- Namespaces -----------------------------------------------------------------------------------------------------

const matchesAny = (patterns: readonly string[], name: string): boolean =>
  patterns.some((pattern) =>
    pattern === '*' || pattern === '**'
      ? true
      : picomatch.isMatch(name, pattern, { dot: true, nocase: true }),
  );

export const isNamespaceAllowed = (policy: RegistryPolicy, serverName: string): boolean =>
  !matchesAny(policy.blockedNamespaces, serverName) &&
  matchesAny(policy.allowedNamespaces, serverName);

// --- Decision -------------------------------------------------------------------------------------------------------

export type InstallActor = {
  id: string;
  orgRole: 'admin' | 'auditor' | 'member';
  /** Teams the actor manages; non-empty makes the actor a manager. */
  managedTeamIds: readonly string[];
};

export type InstallRuntime = 'remote' | 'npm' | 'pypi' | (string & {});

export type InstallDecision = 'allowed-direct' | 'needs-request' | 'catalog-only' | 'denied';

export type InstallEvaluation = {
  decision: InstallDecision;
  reasons: string[];
  risk: Risk;
  /** Set with `catalog-only`: whether this actor may import the entry into the catalog anyway. */
  canImport?: boolean;
};

export const isAdmin = (actor: InstallActor): boolean => actor.orgRole === 'admin';
export const isManager = (actor: InstallActor): boolean => actor.managedTeamIds.length > 0;

const mayInstall = (policy: RegistryPolicy, actor: InstallActor): boolean => {
  if (isAdmin(actor)) return true;
  if (policy.whoMayInstall === 'everyone') return true;
  if (policy.whoMayInstall === 'managers') return isManager(actor);
  return false;
};

/**
 * Decides what happens when `actor` clicks Install (11.7). Order: namespace and runtime allowlists,
 * who may install, then the mode; `direct` above `maxRisk` degrades to `request`.
 */
export const evaluateInstall = (input: {
  policy: RegistryPolicy;
  source: { trust: RegistryTrust };
  serverName: string;
  runtime: InstallRuntime;
  actor: InstallActor;
  /** Overrides the risk derived from source trust. */
  risk?: Risk;
}): InstallEvaluation => {
  const { policy, actor } = input;
  const risk = input.risk ?? riskFromTrust(input.source.trust);
  const deny = (reason: string): InstallEvaluation => ({
    decision: 'denied',
    reasons: [reason],
    risk,
  });

  if (matchesAny(policy.blockedNamespaces, input.serverName)) {
    return deny(`namespace of ${input.serverName} is blocked by policy`);
  }
  if (!matchesAny(policy.allowedNamespaces, input.serverName)) {
    return deny(`namespace of ${input.serverName} is not in the allowed namespaces`);
  }
  if (!(policy.allowedRuntimes as readonly string[]).includes(input.runtime)) {
    return deny(`runtime ${input.runtime} is not allowed by policy`);
  }

  const canImport = isAdmin(actor) || isManager(actor);
  if (policy.mode === 'catalogOnly') {
    return {
      decision: 'catalog-only',
      reasons: ['policy mode is catalogOnly: only admins and managers can import'],
      risk,
      canImport,
    };
  }
  if (!mayInstall(policy, actor)) {
    return deny(`policy allows ${policy.whoMayInstall} to install`);
  }
  if (policy.mode === 'request') {
    return { decision: 'needs-request', reasons: ['policy mode is request'], risk };
  }
  if (exceedsRisk(risk, policy.maxRisk)) {
    return {
      decision: 'needs-request',
      reasons: [
        `risk ${risk} is above maxRisk ${policy.maxRisk}: direct install becomes a request`,
      ],
      risk,
    };
  }
  return { decision: 'allowed-direct', reasons: ['policy mode is direct'], risk };
};

// --- OSV gate -------------------------------------------------------------------------------------------------------

export type LockfileInput = { kind: 'npm-shrinkwrap' | 'uv-requirements'; content: string };

const npmLockPackages = (content: string): OsvPackage[] => {
  const parsed: unknown = JSON.parse(content);
  const packages = (parsed as { packages?: Record<string, { version?: unknown }> } | null)
    ?.packages;
  const out: OsvPackage[] = [];
  for (const [path, info] of Object.entries(packages ?? {})) {
    const marker = 'node_modules/';
    const at = path.lastIndexOf(marker);
    if (at < 0 || typeof info.version !== 'string') continue;
    out.push({ ecosystem: 'npm', name: path.slice(at + marker.length), version: info.version });
  }
  return out;
};

const uvRequirementPackages = (content: string): OsvPackage[] => {
  const out: OsvPackage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;\\]+)/.exec(line);
    if (match)
      out.push({ ecosystem: 'PyPI', name: match[1] as string, version: match[2] as string });
  }
  return out;
};

/** Packages to check: the spec's own package plus every locked transitive dependency. */
export const osvPackagesFor = (spec: ServerSpec, lockfile?: LockfileInput): OsvPackage[] => {
  if (spec.type !== 'package') return [];
  const root: OsvPackage = {
    ecosystem: spec.runtime === 'npm' ? 'npm' : 'PyPI',
    name: spec.identifier,
    version: spec.version,
  };
  const lock = lockfile ?? spec.lockfile;
  let locked: OsvPackage[] = [];
  if (lock) {
    try {
      locked =
        lock.kind === 'npm-shrinkwrap'
          ? npmLockPackages(lock.content)
          : uvRequirementPackages(lock.content);
    } catch {
      locked = [];
    }
  }
  const seen = new Set<string>();
  return [root, ...locked].filter((p) => {
    const key = `${p.ecosystem}:${p.name}@${p.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export type OsvGateResult =
  | { clean: true; checked: number; skipped: boolean }
  | { clean: false; checked: number; malicious: OsvPackageResult[]; error?: string };

/**
 * `requireOsvClean` gate (11.7, 8.7): known-malicious (`MAL-`) advisories block. An OSV outage fails
 * closed. Remote specs have no packages and pass.
 */
export const runOsvGate = async (
  spec: ServerSpec,
  options: {
    requireOsvClean: boolean;
    lockfile?: LockfileInput;
    fetch?: FetchFn;
    baseUrl?: string;
    timeoutMs?: number;
  },
): Promise<OsvGateResult> => {
  if (!options.requireOsvClean) return { clean: true, checked: 0, skipped: true };
  const packages = osvPackagesFor(spec, options.lockfile);
  if (packages.length === 0) return { clean: true, checked: 0, skipped: false };
  try {
    const results = await checkPackagesAgainstOsv(packages, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const malicious = findMaliciousAdvisories(results);
    if (malicious.length > 0) return { clean: false, checked: packages.length, malicious };
    return { clean: true, checked: packages.length, skipped: false };
  } catch (error) {
    return {
      clean: false,
      checked: packages.length,
      malicious: [],
      error: error instanceof Error ? error.message : 'OSV check failed',
    };
  }
};
