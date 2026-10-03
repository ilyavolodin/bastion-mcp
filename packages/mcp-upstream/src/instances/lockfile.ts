import { randomBytes } from 'node:crypto';
import { newId, type PackageSpec, sha256Hex } from '@bastion-mcp/core';
import { buildProxyUrl, captureLockfileVia, type SandboxHandle } from '@bastion-mcp/sandbox';
import { swallow } from './failure';
import { LOCKFILE_WORKSPACE_MIB } from './start';
import type { InstanceManagerDeps } from './types';

/**
 * The one-off sandbox of 8.7: resolves the dependency tree of `identifier@version` into a lockfile (`npm install
 * --package-lock-only`, `uv pip compile --generate-hashes`) with the registry mirrors reachable through the egress
 * proxy, then destroys the sandbox. Used by the catalog TEST flow; nothing is installed or started.
 */
export const captureLockfileIn = async (
  deps: Pick<
    InstanceManagerDeps,
    'driver' | 'egress' | 'egressAddress' | 'npmRegistry' | 'pypiIndexUrl'
  >,
  spec: PackageSpec,
  context: { userId: string | null; label: string; signal?: AbortSignal },
): Promise<{ kind: 'npm-shrinkwrap' | 'uv-requirements'; content: string; sha256: string }> => {
  const instanceId = newId();
  const signal = context.signal ?? new AbortController().signal;
  const egressToken = randomBytes(32).toString('hex');
  let handle: SandboxHandle | undefined;
  try {
    handle = await deps.driver.create(
      {
        instanceId,
        installationId: null,
        userId: context.userId,
        size: spec.size,
        workspace: { persistent: false, sizeMiB: LOCKFILE_WORKSPACE_MIB },
      },
      signal,
    );
    await deps.egress.set(instanceId, {
      tokenSha256: sha256Hex(egressToken),
      allow: spec.egress.allow,
      phase: 'installing',
    });
    const lockfile = await captureLockfileVia(
      handle.runner,
      {
        runtime: spec.runtime,
        identifier: spec.identifier,
        version: spec.version,
        ...(deps.npmRegistry || deps.pypiIndexUrl
          ? {
              registry: {
                ...(deps.npmRegistry ? { npm: deps.npmRegistry } : {}),
                ...(deps.pypiIndexUrl ? { pypi: deps.pypiIndexUrl } : {}),
              },
            }
          : {}),
        egress: { proxyUrl: buildProxyUrl(instanceId, egressToken, deps.egressAddress) },
      },
      { installation: context.label },
      undefined,
      signal,
    );
    return { ...lockfile, sha256: sha256Hex(lockfile.content) };
  } finally {
    if (handle) await swallow(deps.driver.destroy(handle.ref));
    await swallow(deps.egress.delete(instanceId));
  }
};
