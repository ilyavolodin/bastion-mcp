/** Steps of the TEST run of an MCP server version (11.3, 13.6, 8.7): prepare, lockfile, connect, snapshot, scan, osv, era. */
import type { ServerSpec } from '@bastion-mcp/core';
import { type Definition, pinDefinition, pinKey, scanDefinition } from '@bastion-mcp/guards';
import { runOsvGate } from '@bastion-mcp/registry';
import type { UpstreamItems } from '@bastion-mcp/router';
import { assertLockfileIntegrity, checkLockfile, lockfileMatchesSpec } from '@bastion-mcp/sandbox';
import type { Infra } from '../infra';
import { MAX_STEP_DETAIL_CHARS, VERSION_TEST_LIST_TIMEOUT_MS } from '../timing';
import { readStderrTail } from './upstream/stderr';
import type { CatalogRow, StepRunner, TestEnv } from './version-test-types';

/** The hidden installation a test of one version runs against: one per (version, author), reused between runs. */
const testInstallation = async (
  infra: Infra,
  entry: CatalogRow,
  versionId: string,
  authorId: string,
  form: Record<string, unknown>,
  given: Record<string, string> = {},
): Promise<string> => {
  const slug = `test-${versionId.replaceAll('-', '').slice(0, 10)}`;
  const variables: Record<string, string> = {};
  const declared = Array.isArray(form.variables) ? form.variables : [];
  for (const v of declared as { name?: unknown; default?: unknown }[]) {
    if (typeof v.name === 'string' && typeof v.default === 'string') variables[v.name] = v.default;
  }
  // Values the author typed for the test win over defaults (the test installation is the author's own).
  Object.assign(variables, given);
  const existing = await infra.repos.installations.getByOwnerSlug('user', authorId, slug);
  if (existing) {
    if (Object.keys(given).length > 0) {
      const current = await infra.repos.installations.getWithEtag(existing.id);
      if (current) {
        await infra.repos.installations.update(
          existing.id,
          { variables: { ...(current.installation.variables ?? {}), ...given } },
          { ifMatch: current.etag },
        );
      }
    }
    return existing.id;
  }
  const created = await infra.repos.installations.create({
    ownerType: 'user',
    ownerId: authorId,
    catalogEntryId: entry.id,
    catalogVersionId: versionId,
    pinnedVersion: true,
    slug,
    displayName: `Test of ${entry.displayName}`,
    enabled: false,
    variables,
    origin: 'test',
    status: 'ready',
  });
  return created.id;
};

export const runServer = async (
  { infra, deps }: TestEnv,
  ctx: {
    entry: CatalogRow;
    versionId: string;
    authorId: string;
    spec: ServerSpec;
    form: Record<string, unknown>;
    draft: boolean;
    variables?: Record<string, string>;
  },
  step: StepRunner,
): Promise<void> => {
  const prisma = infra.db.prisma;
  const { entry, versionId, authorId, spec } = ctx;
  let installationId = '';
  const state: { items?: UpstreamItems } = {};
  let lockfile: unknown = null;

  const prepared = await step('prepare', async () => {
    installationId = await testInstallation(
      infra,
      entry,
      versionId,
      authorId,
      ctx.form,
      ctx.variables,
    );
    await prisma.definitionPin.deleteMany({ where: { catalogVersionId: versionId } });
    return { status: 'passed', detail: 'test installation ready' };
  });
  if (!prepared) return;

  await step('lockfile', async () => {
    if (spec.type !== 'package')
      return { status: 'skipped', detail: 'remote servers have no lockfile' };
    if (spec.lockfile) {
      assertLockfileIntegrity(spec.lockfile);
      if (lockfileMatchesSpec(spec.lockfile, spec)) {
        lockfile = spec.lockfile;
        return { status: 'passed', detail: `${spec.lockfile.kind} verified` };
      }
      if (!ctx.draft) {
        return {
          status: 'failed',
          detail: `the stored lockfile does not pin ${spec.identifier}@${spec.version}`,
        };
      }
      // A draft whose package or version changed since the capture: resolve again below.
    }
    if (!deps.access.captureLockfile) {
      return {
        status: 'skipped',
        detail:
          'no lockfile: this process runs no sandboxes, so the dependency tree was not resolved (8.7); the install resolves it at start',
      };
    }
    const captured = await deps.access.captureLockfile(spec, {
      userId: authorId,
      label: entry.slug,
    });
    const check = await checkLockfile(captured, { osvCheck: false });
    lockfile = captured;
    if (ctx.draft) {
      await infra.repos.catalogVersions.update(versionId, {
        serverSpec: { ...spec, lockfile: captured },
        lockfile: captured,
      });
    }
    return {
      status: 'passed',
      detail: `resolved ${check.packages.length} pinned packages (${captured.kind}, sha256 ${captured.sha256.slice(0, 12)}...)${ctx.draft ? ', stored on the version' : ''}`,
    };
  });

  const connected = await step('connect', async () => {
    // A new run starts clean: an earlier failure (a fixed spec, a restored network) must not leave the hidden
    // installation in failure backoff (8.6).
    await deps.access.restart(installationId).catch(() => undefined);
    const out = await deps.access.listFresh(installationId, authorId, {
      timeoutMs: VERSION_TEST_LIST_TIMEOUT_MS,
    });
    if (out.status === 'ok') {
      state.items = out.items;
      return { status: 'passed', detail: `connected, ${out.items.tools.length} tools` };
    }
    if (out.code === 'upstream_auth_required') {
      // Not a fault of the server: the author has not signed in to it yet (9.6).
      return {
        status: 'failed',
        detail:
          'This server signs each person in to its own service, and you have not connected your account yet. Connect it, then run the test again.',
        connectUrl: new URL(`/connect/${installationId}`, infra.config.publicUrl).toString(),
      };
    }
    const record = await infra.repos.instances.getForInstallation(installationId);
    const stderr = record ? await readStderrTail(infra, record.id, 20).catch(() => []) : [];
    const failure = record?.error;
    const lines = [`could not list the server (${out.code})`];
    if (out.detail) lines.push(out.detail);
    if (failure) {
      lines.push(`failed in phase "${failure.phase}": ${failure.message}`);
      if (stderr.length === 0 && failure.stderrTail.length > 0) stderr.push(...failure.stderrTail);
    }
    if (stderr.length > 0) lines.push('stderr:', ...stderr);
    return { status: 'failed', detail: lines.join('\n').slice(0, MAX_STEP_DETAIL_CHARS) };
  });
  if (!connected || !state.items) return;
  const listed = state.items;

  await step('snapshot', async () => {
    const registry = infra.repos.installationRegistry;
    const resolved = registry ? await registry.get(installationId) : null;
    const configHash = resolved?.configHash ?? versionId;
    const snapshotId = await infra.repos.snapshots.putReference(versionId, configHash, {
      tools: listed.tools,
      prompts: listed.prompts,
      resources: listed.resources,
      resourceTemplates: listed.resourceTemplates,
      ...(listed.instructions === undefined ? {} : { instructions: listed.instructions }),
      ...(listed.serverInfo === undefined ? {} : { serverInfo: listed.serverInfo }),
    });
    const defs: Definition[] = [
      ...listed.tools.map((t) => ({ ...(t as object), kind: 'tool' }) as Definition),
      ...listed.prompts.map((t) => ({ ...(t as object), kind: 'prompt' }) as Definition),
      ...listed.resources.map((t) => ({ ...(t as object), kind: 'resource' }) as Definition),
      ...listed.resourceTemplates.map(
        (t) => ({ ...(t as object), kind: 'template' }) as Definition,
      ),
    ];
    await infra.repos.definitionPins.upsertPins(
      { catalogVersionId: versionId },
      defs.map((d) => ({
        itemKind: d.kind,
        itemKey: pinKey(d).slice(d.kind.length + 1),
        hash: pinDefinition(d),
        definition: JSON.parse(JSON.stringify(d)) as Record<string, unknown>,
      })),
    );
    if (ctx.draft) {
      await prisma.catalogVersion.update({
        where: { id: versionId },
        data: {
          referenceSnapshotId: snapshotId,
          ...(lockfile ? { lockfile: lockfile as object } : {}),
        },
      });
    }
    await infra.repos.catalogEntries.reindexSearch(entry.id).catch(() => undefined);
    return {
      status: 'passed',
      detail: `${listed.tools.length} tools, ${listed.prompts.length} prompts, ${listed.resources.length} resources, ${listed.resourceTemplates.length} templates pinned`,
    };
  });

  await step('scan', async () => {
    const layers = deps.guards.profiles.layersFor({
      installationId,
      catalogEntryId: entry.id,
      catalogVersionId: versionId,
    });
    const defs: Definition[] = [
      ...listed.tools.map((t) => ({ ...(t as object), kind: 'tool' }) as Definition),
      ...listed.prompts.map((t) => ({ ...(t as object), kind: 'prompt' }) as Definition),
      ...listed.resources.map((t) => ({ ...(t as object), kind: 'resource' }) as Definition),
    ];
    const malicious: string[] = [];
    let suspicious = 0;
    for (const def of defs) {
      const scan = await scanDefinition(
        deps.guards.pipeline,
        def,
        { principal: { principalId: authorId }, installation: { installationId } },
        layers,
      );
      if (scan.malicious) malicious.push(`${def.kind} ${def.name}`);
      else if (scan.result.findings.length > 0) suspicious += 1;
    }
    if (malicious.length > 0) {
      return { status: 'failed', detail: `malicious definitions: ${malicious.join(', ')}` };
    }
    return {
      status: 'passed',
      detail: `${defs.length} definitions scanned${suspicious ? `, ${suspicious} with findings` : ''}`,
    };
  });

  await step('osv', async () => {
    if (spec.type !== 'package')
      return { status: 'skipped', detail: 'remote servers have no packages' };
    const gate = await runOsvGate(spec, {
      requireOsvClean: infra.config.osvCheck,
      ...((deps.fetch ?? infra.options.fetch)
        ? { fetch: (deps.fetch ?? infra.options.fetch) as typeof fetch }
        : {}),
    });
    if (gate.clean) {
      return {
        status: gate.skipped ? 'skipped' : 'passed',
        detail: gate.skipped ? 'BASTION_OSV_CHECK is off' : `${gate.checked} packages checked`,
      };
    }
    return {
      status: 'failed',
      detail:
        gate.error ??
        `known-malicious packages: ${gate.malicious.map((m) => m.package.name).join(', ')}`,
    };
  });

  await step('era', async () => {
    const era = await deps.access.era(installationId);
    if (!era)
      return {
        status: 'skipped',
        detail: 'era not recorded (legacy stateful upstream or cached verdict)',
      };
    if (ctx.draft) {
      await prisma.catalogVersion.update({
        where: { id: versionId },
        data: { protocolEra: era },
      });
    }
    return { status: 'passed', detail: `upstream speaks the ${era} era` };
  });

  await deps.access.restart(installationId).catch(() => undefined);
};
