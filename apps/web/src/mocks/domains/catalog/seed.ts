/** Builds the seeded catalog slice: entries, versions, test runs, files, approvals and auto-install policies. */
import type { Schemas } from '@/api/schema';
import { ME_ID, SEED_IDS } from '../../seed';
import { DAY, iso } from '../../util';
import { SEEDS, type Seed } from './seed-data';
import type { CatalogData, Entry, FileRecord, Policy, Run, Version } from './types';

const remote = (
  slug: string,
  auth: Schemas['CatalogVersion']['serverSpec'],
): Record<string, unknown> => ({
  type: 'remote',
  transport: 'streamable-http',
  url: `https://mcp.${slug}.example.com/mcp`,
  auth,
});

const specFor = (
  s: Seed,
): { spec: Record<string, unknown> | null; form: Version['installForm'] } => {
  const base = baseSpecFor(s);
  return { spec: base.spec, form: s.form ?? base.form };
};

const baseSpecFor = (
  s: Seed,
): { spec: Record<string, unknown> | null; form: Version['installForm'] } => {
  switch (s.spec) {
    case 'oauth':
      return {
        spec: remote(s.slug, {
          mode: 'oauth',
          client: { registration: 'auto' },
          scopes: ['read', 'write'],
          inject: [{ to: 'header', name: 'Authorization', value: 'Bearer {{oauth.accessToken}}' }],
        }),
        form: { variables: [], secrets: [] },
      };
    case 'userSecret': {
      const field = s.secret ?? { name: 'ZENDESK_TOKEN', label: 'Zendesk API token' };
      return {
        spec: remote(s.slug, {
          mode: 'userSecret',
          fields: [field],
          inject: [{ to: 'header', name: field.name, value: `{{secret.${field.name}}}` }],
        }),
        form: { variables: [], secrets: [field] },
      };
    }
    case 'package': {
      const pkg = s.pkg ?? {
        runtime: 'npm' as const,
        identifier: '@acme/pg-mcp',
        version: '3.2.0',
        egress: ['warehouse.acme.internal'],
      };
      return {
        spec: {
          type: 'package',
          runtime: pkg.runtime,
          identifier: pkg.identifier,
          version: pkg.version,
          size: 'small',
          egress: { allow: pkg.egress },
          ...(s.pkg
            ? { auth: { mode: 'none' } }
            : {
                // The secret reaches the process through `auth.inject`: a plain `{{secret.*}}` value cannot resolve.
                auth: {
                  mode: 'orgSecret',
                  inject: [{ to: 'env', name: 'DATABASE_URL', value: '{{secret.DATABASE_URL}}' }],
                },
              }),
        },
        form: { variables: [], secrets: [] },
      };
    }
    case 'none':
      return { spec: null, form: { variables: [], secrets: [] } };
  }
};

/** A finished run of the automatic test (11.2): the step ids the API reports. */
export const passingRun = (versionId: string, startedAt: string): Run => ({
  id: `run-${versionId}`,
  versionId,
  status: 'passed',
  startedAt,
  finishedAt: new Date(new Date(startedAt).getTime() + 4_800).toISOString(),
  steps: [
    {
      id: 'prepare',
      status: 'passed',
      detail: 'npx -y @acme/pg-mcp@3.2.0 · added 41 packages in 2.3s',
    },
    { id: 'connect', status: 'passed', detail: 'initialize ok · protocol 2025-11-25' },
    { id: 'snapshot', status: 'passed', detail: '7 tools, 2 prompts, 1 resource template' },
    { id: 'scan', status: 'passed', detail: 'No injection or invisible text in 10 descriptions' },
    { id: 'osv', status: 'passed', detail: 'No known vulnerabilities' },
    {
      id: 'guards',
      status: 'passed',
      detail: 'warn: DATABASE_URL uses a read-write role; consider analytics_ro',
    },
  ],
});

const MARKDOWN =
  '---\nname: incident-triage\ndescription: Triage an incident and draft a timeline when a page fires\nallowed-tools: Read, Grep\n---\n# Incident triage\n\n1. Collect the alert and recent deploys.\n2. Build a timeline.\n3. Draft the first update.\n';

const filesFor = (versionId: string, slug: string, at: string): FileRecord[] => {
  const plain = (path: string, content: string): FileRecord => ({
    versionId,
    path,
    mode: 'file',
    classification: 'plain',
    content,
    updatedAt: at,
  });
  const code = (path: string, content: string): FileRecord => ({
    versionId,
    path,
    mode: 'executable',
    classification: 'executable',
    content,
    updatedAt: at,
  });
  if (slug === 'incident-kit') {
    return [
      plain('SKILL.md', MARKDOWN),
      plain('references/runbook.md', '# Runbook\nEscalate after 15 minutes.\n'),
      code('hooks/post-tool.sh', '#!/bin/sh\ncurl -s $PAGER_URL -d @-\n'),
      code('scripts/timeline.py', 'print("timeline")\n'),
    ];
  }
  return [plain('SKILL.md', `---\nname: ${slug}\ndescription: ${slug} skill\n---\n# ${slug}\n`)];
};

export const buildCatalogData = (now: number): CatalogData => {
  const entries: Entry[] = [];
  const versions: Version[] = [];
  const files: FileRecord[] = [];
  const approvals: CatalogData['approvals'] = {};
  const published = iso(now - 6 * DAY);
  const draftAt = iso(now - DAY);

  const version = (
    e: Entry,
    label: string,
    status: Version['status'],
    s: Seed,
    at: string,
    run: Run | null,
    changelog: string,
  ): Version => {
    const { spec, form } = specFor(s);
    const id = `v-${e.slug}-${label}`;
    return {
      id,
      entryId: e.id,
      label,
      serverSpec: spec,
      overrides:
        e.slug === 'postgres'
          ? { version: 1, tools: { pg_write_rows: { hidden: true } } }
          : { version: 1 },
      guardProfileId: null,
      limits: [],
      installForm: form,
      lockfile: null,
      referenceSnapshotId: null,
      protocolEra: null,
      testResult: run,
      runtime: {},
      status,
      changelog,
      createdBy: 'u-raj',
      createdAt: at,
      publishedAt: status === 'published' ? at : null,
      updatedAt: at,
    };
  };

  for (const s of SEEDS) {
    const id = `c-${s.slug}`;
    const entry: Entry = {
      id,
      slug: s.slug,
      kind: s.kind,
      displayName: s.name,
      description: s.desc,
      tags: [],
      ownerTeamId: s.owner?.id ?? null,
      visibility: {
        org: !s.owner || s.owner.teams.length === 0,
        teamIds: s.owner?.teams ?? [],
        userIds: [],
      },
      status: s.draft ? 'draft' : 'published',
      risk: s.risk ?? 'low',
      source: s.registry
        ? { kind: 'registry', registrySourceId: 'rs-official', serverName: 'io.atlassian/jira' }
        : { kind: 'manual' },
      currentVersionId: s.draft ? null : `v-${s.slug}-${s.label}`,
      autoUpgrade: true,
      userOverrides: 'cosmetic',
      onDrift: 'hideChanged',
      createdBy: 'u-raj',
      createdAt: iso(now - 30 * DAY),
      updatedAt: s.draft ? draftAt : published,
    };
    entries.push(entry);
    if (s.draft) {
      const v = version(
        entry,
        s.label,
        'draft',
        s,
        draftAt,
        passingRun(`v-${s.slug}-${s.label}`, draftAt),
        'Adds weekly_metrics prompt',
      );
      versions.push(v);
    } else {
      const v = version(
        entry,
        s.label,
        'published',
        s,
        published,
        passingRun(`v-${s.slug}-${s.label}`, published),
        'Published',
      );
      versions.push(v);
      if (s.kind !== 'mcp_server') {
        files.push(...filesFor(v.id, s.slug, published));
        if (s.slug === 'incident-kit') {
          approvals[v.id] = { approvedBy: ME_ID, approvedAt: published, note: null };
        }
      }
    }
    if (s.extraDraft) {
      const v = version(
        entry,
        s.extraDraft,
        'draft',
        s,
        draftAt,
        passingRun(`v-${s.slug}-${s.extraDraft}`, draftAt),
        'Adds a postmortem template',
      );
      versions.push(v);
      files.push(...filesFor(v.id, s.slug, draftAt));
    }
  }

  const autoInstall: Policy[] = [
    {
      id: 'ap-1',
      catalogEntryId: SEED_IDS.catalogEntry.jira,
      target: { all: true },
      mode: 'default',
      scope: 'user',
      applyToExisting: true,
      enabled: true,
      createdBy: ME_ID,
      createdAt: iso(now - 20 * DAY),
      updatedAt: iso(now - 20 * DAY),
    },
    {
      id: 'ap-2',
      catalogEntryId: SEED_IDS.catalogEntry.postgres,
      target: { teamIds: ['t-data', 't-analytics'] },
      mode: 'required',
      scope: 'team',
      applyToExisting: true,
      enabled: true,
      createdBy: ME_ID,
      createdAt: iso(now - 10 * DAY),
      updatedAt: iso(now - 10 * DAY),
    },
  ];
  return { entries, versions, autoInstall, files, approvals, testStarts: {}, secrets: {} };
};
