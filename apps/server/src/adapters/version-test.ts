/**
 * The catalog TEST flow (11.2, 11.3, 13.6, 25.3): `VersionTestPort` of the API.
 *
 * For an MCP server version the run
 *  1. prepares a hidden test installation for the author, pinned to the version (so the real upstream layer, with its
 *     credential resolution, egress rules and instance management, runs the test exactly as production would);
 *  2. checks the lockfile of package servers, or captures one in a throwaway sandbox (8.7: the runner resolves the
 *     dependency tree with `npm install --package-lock-only` or `uv pip compile --generate-hashes`) and stores it on
 *     the draft version;
 *  3. connects as the author and lists tools, prompts, resources and templates live;
 *  4. stores them as the version's reference snapshot (`reference_snapshot_id`, search document), pins every definition
 *     (13.6) and records the protocol era;
 *  5. runs the definition-phase guards over every definition (a `malicious` verdict fails the test);
 *  6. runs the OSV gate for package servers.
 * Skill and plugin versions run the file checks of 25.3 instead (rendering schema, classification, guards, OSV).
 *
 * Progress is persisted in `catalog_versions.test_result` after every step (the API reads it for `GET .../test` and
 * the publish precondition) and published as `test.progress` events on the SSE bus. The run continues in the
 * background; `start` returns the running record at once.
 */
import type { EventBus, VersionTestPort, VersionTestRun, VersionTestStep } from '@bastion-mcp/api';
import { newId, type ServerSpec, serverSpecSchema } from '@bastion-mcp/core';
import { type Definition, pinDefinition, pinKey, scanDefinition } from '@bastion-mcp/guards';
import {
  classificationStep,
  decodeUtf8,
  loadVersionFiles,
  type PluginFile,
  renderPlugin,
  runOsvStep,
  type TestStepResult,
  validateAgentPluginsRendering,
} from '@bastion-mcp/plugins';
import { runOsvGate } from '@bastion-mcp/registry';
import type { UpstreamItems } from '@bastion-mcp/router';
import { assertLockfileIntegrity, checkLockfile, lockfileMatchesSpec } from '@bastion-mcp/sandbox';
import type { GuardService } from '../contracts';
import type { Infra } from '../infra';
import { assembleReleaseItem, semverOf } from './plugin-content';
import { readStderrTail } from './upstream/stderr';
import type { UpstreamAccess } from './upstream-access';

const STALE_AFTER_MS = 15 * 60_000;

type StepOutcome = { status: VersionTestStep['status']; detail?: string; connectUrl?: string };

type Row = {
  id: string;
  slug: string;
  kind: string;
  displayName: string;
};

const parseRun = (raw: unknown): VersionTestRun | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const run = raw as Partial<VersionTestRun>;
  if (typeof run.id !== 'string' || !Array.isArray(run.steps)) return null;
  return run as VersionTestRun;
};

const textOf = (file: PluginFile): string | undefined => decodeUtf8(file.content);

export type VersionTestDeps = {
  access: UpstreamAccess;
  guards: Pick<GuardService, 'pipeline' | 'profiles'>;
  events: EventBus;
  /** Frees a test instance after the run (worker role only); optional because ui-only processes use RPC restart. */
  fetch?: typeof fetch;
};

export const createVersionTestPort = (infra: Infra, deps: VersionTestDeps): VersionTestPort => {
  const prisma = infra.db.prisma;

  const persist = (versionId: string, run: VersionTestRun, extra: object = {}) =>
    infra.repos.catalogVersions.setTestResult(versionId, { ...run, ...extra });

  /** The hidden installation a test of one version runs against: one per (version, author), reused between runs. */
  const testInstallation = async (
    entry: Row,
    versionId: string,
    authorId: string,
    form: Record<string, unknown>,
    given: Record<string, string> = {},
  ): Promise<string> => {
    const slug = `test-${versionId.replaceAll('-', '').slice(0, 10)}`;
    const variables: Record<string, string> = {};
    const declared = Array.isArray(form.variables) ? form.variables : [];
    for (const v of declared as { name?: unknown; default?: unknown }[]) {
      if (typeof v.name === 'string' && typeof v.default === 'string')
        variables[v.name] = v.default;
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

  const runServer = async (
    ctx: {
      entry: Row;
      versionId: string;
      authorId: string;
      spec: ServerSpec;
      form: Record<string, unknown>;
      draft: boolean;
      variables?: Record<string, string>;
    },
    step: (id: string, fn: () => Promise<StepOutcome>) => Promise<boolean>,
  ): Promise<void> => {
    const { entry, versionId, authorId, spec } = ctx;
    let installationId = '';
    const state: { items?: UpstreamItems } = {};
    let lockfile: unknown = null;

    const prepared = await step('prepare', async () => {
      installationId = await testInstallation(entry, versionId, authorId, ctx.form, ctx.variables);
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
      const out = await deps.access.listFresh(installationId, authorId, { timeoutMs: 150_000 });
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
        if (stderr.length === 0 && failure.stderrTail.length > 0)
          stderr.push(...failure.stderrTail);
      }
      if (stderr.length > 0) lines.push('stderr:', ...stderr);
      return { status: 'failed', detail: lines.join('\n').slice(0, 8000) };
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
          ? { fetch: (deps.fetch ?? infra.options.fetch) as never }
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

  const runFiles = async (
    ctx: { entry: Row; versionId: string; authorId: string; label: string },
    step: (id: string, fn: () => Promise<StepOutcome>) => Promise<boolean>,
  ): Promise<void> => {
    const { entry, versionId, authorId } = ctx;
    const files = await loadVersionFiles(
      { blobs: infra.repos.blobs, files: infra.repos.catalogFiles },
      versionId,
    );
    const convert = (r: TestStepResult) => ({
      status: r.status,
      detail: `${r.summary}${r.findings.length ? `: ${r.findings.map((f) => f.message).join('; ')}` : ''}`,
    });
    let rendered: ReturnType<typeof renderPlugin> | undefined;
    await step('render', async () => {
      const item = await assembleReleaseItem({
        entry: { id: entry.id, slug: entry.slug, displayName: entry.displayName, kind: entry.kind },
        version: { id: versionId, label: ctx.label },
        policy: 'available',
        files: files.map((f) => ({ path: f.path, content: f.content, mode: f.mode })),
        loadSkillFiles: async (slug, label) => {
          const target = await infra.repos.catalogEntries.getBySlug(slug);
          if (!target) return null;
          const version = label
            ? await infra.repos.catalogVersions.getByLabel(target.id, label)
            : target.currentVersionId
              ? await infra.repos.catalogVersions.get(target.currentVersionId)
              : null;
          if (!version) return null;
          const skillFiles = await loadVersionFiles(
            { blobs: infra.repos.blobs, files: infra.repos.catalogFiles },
            version.id,
          );
          return {
            slug: target.slug,
            files: skillFiles.map((f) => ({ path: f.path, content: f.content, mode: f.mode })),
          };
        },
      });
      rendered = renderPlugin(item, infra.config.publicUrl);
      return {
        status: 'passed',
        detail: `renders as ${item.name}@${item.version} (${semverOf(ctx.label)})`,
      };
    });
    await step('agent-plugins-schema', async () =>
      rendered
        ? convert(validateAgentPluginsRendering(rendered.agentsFiles))
        : { status: 'skipped', detail: 'nothing rendered' },
    );
    await step('claude-validate', async () => ({
      status: 'skipped',
      detail: '`claude plugin validate` needs the claude CLI in a sandbox; not available here',
    }));
    await step('guards', async () => {
      const layers = deps.guards.profiles.layersFor({
        installationId: entry.id,
        catalogEntryId: entry.id,
        catalogVersionId: versionId,
      });
      const bad: string[] = [];
      let scanned = 0;
      for (const file of files) {
        const text = textOf(file);
        if (text === undefined || text.length === 0) continue;
        scanned += 1;
        const scan = await (await import('@bastion-mcp/guards')).scanTextFile(
          deps.guards.pipeline,
          { path: file.path, text },
          { principal: { principalId: authorId }, installation: { installationId: entry.id } },
          layers,
        );
        if (scan.malicious) bad.push(file.path);
      }
      return bad.length > 0
        ? { status: 'failed', detail: `malicious content in ${bad.join(', ')}` }
        : { status: 'passed', detail: `${scanned} text files scanned` };
    });
    await step('osv', async () =>
      convert(
        await runOsvStep(
          files,
          (deps.fetch ?? infra.options.fetch)
            ? { fetch: (deps.fetch ?? infra.options.fetch) as never }
            : {},
        ),
      ),
    );
    await step('classification', async () => convert(classificationStep(files)));
  };

  return {
    async start({ entryId, versionId, requestedBy, variables }) {
      const entry = await prisma.catalogEntry.findUnique({ where: { id: entryId } });
      const version = await prisma.catalogVersion.findUnique({ where: { id: versionId } });
      if (!entry || !version || version.entryId !== entryId)
        throw new Error('catalog version not found');
      const current = parseRun(version.testResult);
      if (
        current?.status === 'running' &&
        Date.now() - Date.parse(current.startedAt) < STALE_AFTER_MS
      ) {
        return current;
      }
      const run: VersionTestRun = {
        id: newId(),
        versionId,
        status: 'running',
        steps: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      await persist(versionId, run);

      const emit = (step: VersionTestStep | undefined) =>
        deps.events.publish({
          id: newId(),
          type: 'test.progress',
          audience: { userIds: [requestedBy] },
          data: {
            runId: run.id,
            entryId,
            versionId,
            status: run.status,
            ...(step ? { step } : {}),
          },
          topic: versionId,
        });

      const step = async (id: string, fn: () => Promise<StepOutcome>): Promise<boolean> => {
        const pending: VersionTestStep = { id, status: 'running' };
        run.steps.push(pending);
        await persist(versionId, run);
        await emit(pending);
        try {
          const out = await fn();
          pending.status = out.status;
          if (out.detail !== undefined) pending.detail = out.detail;
          if (out.connectUrl !== undefined) pending.connectUrl = out.connectUrl;
        } catch (error) {
          pending.status = 'failed';
          pending.detail = error instanceof Error ? error.message : String(error);
        }
        await persist(versionId, run);
        await emit(pending);
        return pending.status !== 'failed';
      };

      void (async () => {
        try {
          const draft = version.status === 'draft';
          if (entry.kind === 'mcp_server') {
            const parsed = serverSpecSchema.safeParse(version.serverSpec);
            if (!parsed.success) {
              await step('prepare', async () => ({
                status: 'failed',
                detail: 'the server spec is invalid',
              }));
            } else {
              await runServer(
                {
                  entry,
                  versionId,
                  authorId: requestedBy,
                  spec: parsed.data,
                  form: (version.installForm ?? {}) as Record<string, unknown>,
                  draft,
                  ...(variables ? { variables } : {}),
                },
                step,
              );
            }
          } else {
            await runFiles({ entry, versionId, authorId: requestedBy, label: version.label }, step);
          }
        } catch (error) {
          run.steps.push({
            id: 'run',
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        } finally {
          run.status = run.steps.some((s) => s.status === 'failed') ? 'failed' : 'passed';
          run.finishedAt = new Date().toISOString();
          await persist(versionId, run).catch(() => undefined);
          await emit(undefined);
        }
      })();
      return run;
    },

    async latest(versionId) {
      const row = await prisma.catalogVersion.findUnique({
        where: { id: versionId },
        select: { testResult: true },
      });
      const run = parseRun(row?.testResult);
      if (!run) return null;
      if (run.status === 'running' && Date.now() - Date.parse(run.startedAt) > STALE_AFTER_MS) {
        return {
          ...run,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          steps: [...run.steps, { id: 'run', status: 'failed', detail: 'the run was interrupted' }],
        };
      }
      return run;
    },
  };
};
