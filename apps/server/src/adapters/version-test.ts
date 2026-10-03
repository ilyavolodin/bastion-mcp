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
import type { VersionTestPort, VersionTestRun } from '@bastion-mcp/api';
import { newId, serverSpecSchema } from '@bastion-mcp/core';
import type { Infra } from '../infra';
import { runFiles } from './version-test-files';
import { isStale, parseRun, type RunAction, reduceRun, startRun } from './version-test-run';
import { runServer } from './version-test-server';
import type { StepOutcome, VersionTestDeps } from './version-test-types';

export type { VersionTestDeps } from './version-test-types';

export const createVersionTestPort = (infra: Infra, deps: VersionTestDeps): VersionTestPort => {
  const prisma = infra.db.prisma;
  const env = { infra, deps };
  const nowIso = (): string => new Date(infra.clock.now()).toISOString();

  const persist = (versionId: string, run: VersionTestRun, extra: object = {}) =>
    infra.repos.catalogVersions.setTestResult(versionId, { ...run, ...extra });

  return {
    async start({ entryId, versionId, requestedBy, variables }) {
      const entry = await prisma.catalogEntry.findUnique({ where: { id: entryId } });
      const version = await prisma.catalogVersion.findUnique({ where: { id: versionId } });
      if (!entry || !version || version.entryId !== entryId)
        throw new Error('catalog version not found');
      const current = parseRun(version.testResult);
      if (current?.status === 'running' && !isStale(current, infra.clock.now())) {
        return current;
      }
      let run = startRun(newId(), versionId, nowIso());
      const apply = (action: RunAction): void => {
        run = reduceRun(run, action);
      };
      const initial = run;
      await persist(versionId, run);

      const emit = (step: VersionTestRun['steps'][number] | undefined) =>
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
        const index = run.steps.length;
        apply({ type: 'step-start', id });
        await persist(versionId, run);
        await emit(run.steps[index]);
        try {
          apply({ type: 'step-end', index, outcome: await fn() });
        } catch (error) {
          apply({
            type: 'step-error',
            index,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        await persist(versionId, run);
        await emit(run.steps[index]);
        return run.steps[index]?.status !== 'failed';
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
                env,
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
            await runFiles(
              env,
              { entry, versionId, authorId: requestedBy, label: version.label },
              step,
            );
          }
        } catch (error) {
          apply({
            type: 'run-error',
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          apply({ type: 'finish', at: nowIso() });
          await persist(versionId, run).catch(() => undefined);
          await emit(undefined);
        }
      })();
      return initial;
    },

    async latest(versionId) {
      const row = await prisma.catalogVersion.findUnique({
        where: { id: versionId },
        select: { testResult: true },
      });
      const run = parseRun(row?.testResult);
      if (!run) return null;
      if (isStale(run, infra.clock.now()))
        return reduceRun(run, { type: 'interrupt', at: nowIso() });
      return run;
    },
  };
};
