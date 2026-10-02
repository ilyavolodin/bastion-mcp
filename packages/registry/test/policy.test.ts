import { parseServerSpec } from '@bastion-mcp/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY_POLICY,
  evaluateInstall,
  exceedsRisk,
  type InstallActor,
  isNamespaceAllowed,
  osvPackagesFor,
  parseRegistryPolicy,
  type RegistryPolicy,
  registryPolicySchema,
  riskFromTrust,
  runOsvGate,
} from '../src';

const admin: InstallActor = { id: 'a', orgRole: 'admin', managedTeamIds: [] };
const manager: InstallActor = { id: 'm', orgRole: 'member', managedTeamIds: ['t1'] };
const member: InstallActor = { id: 'u', orgRole: 'member', managedTeamIds: [] };

const policy = (over: Partial<RegistryPolicy> = {}): RegistryPolicy =>
  registryPolicySchema.parse(over);
const evalWith = (p: RegistryPolicy, over: Partial<Parameters<typeof evaluateInstall>[0]> = {}) =>
  evaluateInstall({
    policy: p,
    source: { trust: 'official' },
    serverName: 'io.github.acme/x',
    runtime: 'remote',
    actor: manager,
    ...over,
  });

describe('11.7 policy defaults', () => {
  it('11.7 defaults are the secure ones of 22.5', () => {
    expect(DEFAULT_REGISTRY_POLICY).toEqual({
      allowedNamespaces: ['*'],
      blockedNamespaces: [],
      allowedRuntimes: ['remote'],
      whoMayInstall: 'managers',
      mode: 'request',
      requireOsvClean: true,
      maxRisk: 'low',
    });
    expect(parseRegistryPolicy(undefined)).toEqual(DEFAULT_REGISTRY_POLICY);
  });

  it('11.7 rejects unknown values', () => {
    expect(() => registryPolicySchema.parse({ mode: 'yolo' })).toThrow();
    expect(() => registryPolicySchema.parse({ allowedRuntimes: ['oci'] })).toThrow();
    expect(() => registryPolicySchema.parse({ maxRisk: 'critical' })).toThrow();
  });
});

describe('11.7 risk', () => {
  it('11.7 official and internal are low, community is medium', () => {
    expect(riskFromTrust('official')).toBe('low');
    expect(riskFromTrust('internal')).toBe('low');
    expect(riskFromTrust('community')).toBe('medium');
    expect(exceedsRisk('medium', 'low')).toBe(true);
    expect(exceedsRisk('low', 'low')).toBe(false);
  });
});

describe('11.7 namespaces', () => {
  it('11.7 globs match on the server name', () => {
    const p = policy({
      allowedNamespaces: ['io.github.acme/*', 'com.atlassian/*'],
      blockedNamespaces: ['io.github.acme/secret-*'],
    });
    expect(isNamespaceAllowed(p, 'io.github.acme/server')).toBe(true);
    expect(isNamespaceAllowed(p, 'com.atlassian/jira')).toBe(true);
    expect(isNamespaceAllowed(p, 'io.github.other/server')).toBe(false);
    expect(isNamespaceAllowed(p, 'io.github.acme/secret-vault')).toBe(false);
    expect(isNamespaceAllowed(policy({ allowedNamespaces: ['**'] }), 'a.b/c')).toBe(true);
    expect(
      isNamespaceAllowed(policy({ allowedNamespaces: ['IO.GITHUB.ACME/*'] }), 'io.github.acme/x'),
    ).toBe(true);
  });

  it('11.7 default allow * covers every name and blocking wins over allowing', () => {
    expect(isNamespaceAllowed(policy(), 'com.any/thing')).toBe(true);
    expect(isNamespaceAllowed(policy({ blockedNamespaces: ['com.any/*'] }), 'com.any/thing')).toBe(
      false,
    );
  });
});

describe('11.7 evaluateInstall', () => {
  it('11.7 blocked and non-allowed namespaces are denied', () => {
    expect(evalWith(policy({ blockedNamespaces: ['io.github.acme/*'] })).decision).toBe('denied');
    expect(evalWith(policy({ allowedNamespaces: ['com.other/*'] })).decision).toBe('denied');
  });

  it('11.7 runtimes outside allowedRuntimes are denied (default remote only)', () => {
    expect(evalWith(policy(), { runtime: 'npm' })).toMatchObject({ decision: 'denied' });
    expect(
      evalWith(policy({ allowedRuntimes: ['remote', 'npm'] }), { runtime: 'npm' }).decision,
    ).toBe('needs-request');
    expect(evalWith(policy(), { runtime: 'oci' }).decision).toBe('denied');
  });

  it('11.7 request mode is the default and yields needs-request', () => {
    expect(evalWith(policy())).toMatchObject({ decision: 'needs-request', risk: 'low' });
  });

  it('11.7 direct mode allows a low-risk install', () => {
    expect(evalWith(policy({ mode: 'direct' })).decision).toBe('allowed-direct');
  });

  it('11.7 direct above maxRisk downgrades to request; raising maxRisk restores direct', () => {
    const community = { source: { trust: 'community' as const } };
    const downgraded = evalWith(policy({ mode: 'direct' }), community);
    expect(downgraded).toMatchObject({ decision: 'needs-request', risk: 'medium' });
    expect(downgraded.reasons.join(' ')).toMatch(/maxRisk/);
    expect(evalWith(policy({ mode: 'direct', maxRisk: 'medium' }), community).decision).toBe(
      'allowed-direct',
    );
    expect(evalWith(policy({ mode: 'direct' }), { risk: 'high' }).decision).toBe('needs-request');
  });

  it('11.7 whoMayInstall admins, managers, everyone', () => {
    const p = (who: RegistryPolicy['whoMayInstall']) =>
      policy({ whoMayInstall: who, mode: 'direct' });
    expect(evalWith(p('admins'), { actor: admin }).decision).toBe('allowed-direct');
    expect(evalWith(p('admins'), { actor: manager }).decision).toBe('denied');
    expect(evalWith(p('managers'), { actor: manager }).decision).toBe('allowed-direct');
    expect(evalWith(p('managers'), { actor: member }).decision).toBe('denied');
    expect(evalWith(p('everyone'), { actor: member }).decision).toBe('allowed-direct');
  });

  it('11.7 catalogOnly: everyone sees catalog-only, admins and managers may import', () => {
    const p = policy({ mode: 'catalogOnly' });
    expect(evalWith(p, { actor: member })).toMatchObject({
      decision: 'catalog-only',
      canImport: false,
    });
    expect(evalWith(p, { actor: manager })).toMatchObject({
      decision: 'catalog-only',
      canImport: true,
    });
    expect(evalWith(p, { actor: admin })).toMatchObject({
      decision: 'catalog-only',
      canImport: true,
    });
  });

  it('property 11.7 direct is never allowed above maxRisk and a blocked namespace is never installable', () => {
    const risks = fc.constantFrom('low', 'medium', 'high' as const);
    fc.assert(
      fc.property(
        risks,
        risks,
        fc.constantFrom('direct', 'request', 'catalogOnly' as const),
        fc.constantFrom('admins', 'managers', 'everyone' as const),
        fc.constantFrom(admin, manager, member),
        (risk, maxRisk, mode, whoMayInstall, actor) => {
          const p = policy({ mode, maxRisk, whoMayInstall });
          const out = evalWith(p, { risk, actor });
          if (out.decision === 'allowed-direct') {
            expect(exceedsRisk(risk, maxRisk)).toBe(false);
            expect(mode).toBe('direct');
          }
          const blocked = evalWith(policy({ ...p, blockedNamespaces: ['io.github.acme/*'] }), {
            risk,
            actor,
          });
          expect(blocked.decision).toBe('denied');
        },
      ),
    );
  });
});

describe('11.7 / 8.7 OSV gate', () => {
  const npmSpec = parseServerSpec({
    type: 'package',
    runtime: 'npm',
    identifier: 'left-pad',
    version: '1.3.0',
    auth: { mode: 'none' },
  });
  const remoteSpec = parseServerSpec({
    type: 'remote',
    transport: 'streamable-http',
    url: 'https://x.example/mcp',
    auth: { mode: 'none' },
  });
  const osv = (byName: Record<string, string[]>) => {
    const queries: unknown[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { queries: { package: { name: string } }[] };
      queries.push(...body.queries);
      return new Response(
        JSON.stringify({
          results: body.queries.map((q) => ({
            vulns: (byName[q.package.name] ?? []).map((id) => ({ id })),
          })),
        }),
      );
    };
    return { fetchFn, queries };
  };

  it('11.7 requireOsvClean false skips the check', async () => {
    expect(await runOsvGate(npmSpec, { requireOsvClean: false })).toEqual({
      clean: true,
      checked: 0,
      skipped: true,
    });
  });

  it('11.7 remote specs have nothing to check', async () => {
    expect(await runOsvGate(remoteSpec, { requireOsvClean: true })).toEqual({
      clean: true,
      checked: 0,
      skipped: false,
    });
  });

  it('11.7 a clean package passes; ordinary CVEs do not block', async () => {
    const { fetchFn } = osv({ 'left-pad': ['GHSA-1234'] });
    expect(await runOsvGate(npmSpec, { requireOsvClean: true, fetch: fetchFn })).toEqual({
      clean: true,
      checked: 1,
      skipped: false,
    });
  });

  it('11.7 a MAL- advisory blocks', async () => {
    const { fetchFn } = osv({ 'left-pad': ['MAL-2025-1'] });
    const out = await runOsvGate(npmSpec, { requireOsvClean: true, fetch: fetchFn });
    expect(out).toMatchObject({ clean: false, malicious: [{ advisoryIds: ['MAL-2025-1'] }] });
  });

  it('8.7 locked transitive dependencies are checked too (npm shrinkwrap)', async () => {
    const lock = JSON.stringify({
      packages: {
        '': { name: 'root' },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/a/node_modules/evil': { version: '9.9.9' },
      },
    });
    const { fetchFn, queries } = osv({ evil: ['MAL-7'] });
    const out = await runOsvGate(npmSpec, {
      requireOsvClean: true,
      fetch: fetchFn,
      lockfile: { kind: 'npm-shrinkwrap', content: lock },
    });
    expect(queries).toHaveLength(2);
    expect(out).toMatchObject({ clean: false, checked: 2 });
  });

  it('8.7 uv requirements are parsed and PyPI is the ecosystem', () => {
    const spec = parseServerSpec({
      type: 'package',
      runtime: 'pypi',
      identifier: 'pkg',
      version: '1.0',
      auth: { mode: 'none' },
    });
    const content =
      '# comment\npkg==1.0 \\\n    --hash=sha256:abc\nrequests[socks]==2.32.3 ; python_version>"3"\nplain-line\n';
    expect(osvPackagesFor(spec, { kind: 'uv-requirements', content })).toEqual([
      { ecosystem: 'PyPI', name: 'pkg', version: '1.0' },
      { ecosystem: 'PyPI', name: 'requests', version: '2.32.3' },
    ]);
  });

  it('8.7 an unreadable lockfile falls back to the root package', () => {
    expect(osvPackagesFor(npmSpec, { kind: 'npm-shrinkwrap', content: '{broken' })).toHaveLength(1);
  });

  it('11.7 an OSV outage fails closed', async () => {
    const out = await runOsvGate(npmSpec, {
      requireOsvClean: true,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(out).toMatchObject({ clean: false, malicious: [], error: 'OSV request failed' });
  });
});
