/** Steps of the TEST run of a skill or plugin version (25.3): render, schema, guards, OSV, classification. */
import { scanTextFile } from '@bastion-mcp/guards';
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
import { assembleReleaseItem, semverOf } from './plugin-content';
import type { CatalogRow, StepRunner, TestEnv } from './version-test-types';

const textOf = (file: PluginFile): string | undefined => decodeUtf8(file.content);

export const runFiles = async (
  { infra, deps }: TestEnv,
  ctx: { entry: CatalogRow; versionId: string; authorId: string; label: string },
  step: StepRunner,
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
      const scan = await scanTextFile(
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
          ? { fetch: (deps.fetch ?? infra.options.fetch) as typeof fetch }
          : {},
      ),
    ),
  );
  await step('classification', async () => convert(classificationStep(files)));
};
