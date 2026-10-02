/**
 * MSW mock of the catalog routes (entries, versions, test runs, publish, executable approvals, files, per-version
 * overrides, auto-install policies), typed by the generated OpenAPI types (see `../http.ts`). Rows are in the shape of
 * the API (`Schemas[...]`); `buildCatalogData` seeds the Acme catalog, `catalogHandlers` answer from
 * `getDb().data.catalog`.
 */
import { slugify } from '@bastion-mcp/core/ids';
import type { HttpHandler } from 'msw';
import type { Body, Res, Schemas } from '@/api/schema';
import {
  etagHeaders,
  forbidden,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  problem,
  route,
  type Sample,
  type SampleFactory,
} from '../http';
import { getDb, nextId } from '../state';

type Entry = Schemas['CatalogEntry'];
type Version = Schemas['CatalogVersion'];
type Run = Schemas['VersionTestRun'];
type Policy = Schemas['AutoInstallPolicy'];

/** A file of a skill or plugin version: the row plus its text (the API stores the bytes as a blob). */
export type FileRecord = {
  versionId: string;
  path: string;
  mode: 'file' | 'executable';
  classification: 'plain' | 'executable';
  content: string;
  updatedAt: string;
};

export type CatalogData = {
  entries: Entry[];
  /** Flat, `entryId` on every row. */
  versions: Version[];
  autoInstall: Policy[];
  files: FileRecord[];
  /** `executable_approvals` by version id. */
  approvals: Record<string, { approvedBy: string; approvedAt: string; note: string | null }>;
  /** When the test of a version was started (the mock finishes it a moment later). */
  testStarts: Record<string, number>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

// --- seed ---------------------------------------------------------------------------------------------------------

type Seed = {
  slug: string;
  name: string;
  kind: Entry['kind'];
  desc: string;
  label: string;
  risk?: Entry['risk'];
  owner?: { id: string; teams: string[] };
  draft?: boolean;
  spec: 'oauth' | 'userSecret' | 'package' | 'none';
  registry?: boolean;
  /** A draft version in addition to the published one. */
  extraDraft?: string;
  /** The `userSecret` field of the sign-in (default: the Zendesk token). */
  secret?: { name: string; label: string };
  /** A package spec (default: the Postgres one). */
  pkg?: { runtime: 'npm' | 'pypi'; identifier: string; version: string; egress: string[] };
  /** What the installer fills in, when the spec derives none. */
  form?: Version['installForm'];
};

const SEEDS: Seed[] = [
  {
    slug: 'jira',
    name: 'Jira',
    kind: 'mcp_server',
    desc: 'Issues, projects and sprints',
    label: '1.8.2',
    spec: 'oauth',
    registry: true,
    form: {
      variables: [
        {
          name: 'SITE_URL',
          label: 'Jira site',
          description: 'Your Atlassian cloud address',
          required: true,
          default: 'https://acme.atlassian.net',
        },
      ],
      secrets: [],
    },
  },
  {
    slug: 'linear',
    name: 'Linear',
    kind: 'mcp_server',
    desc: 'Issues and cycles for product teams',
    label: '1.2.0',
    spec: 'oauth',
  },
  {
    slug: 'github',
    name: 'GitHub',
    kind: 'mcp_server',
    desc: 'Repos, pull requests and issues',
    label: '2.4.0',
    spec: 'oauth',
    risk: 'medium',
  },
  {
    slug: 'postgres',
    name: 'Postgres analytics',
    kind: 'mcp_server',
    desc: 'Read-only SQL on the warehouse',
    label: '3.2.0',
    spec: 'package',
    risk: 'medium',
    draft: true,
    owner: { id: 't-data', teams: ['t-data', 't-analytics'] },
  },
  {
    slug: 'zendesk',
    name: 'Zendesk',
    kind: 'mcp_server',
    desc: 'Support tickets and macros',
    label: '1.1.0',
    spec: 'userSecret',
    owner: { id: 't-support', teams: [] },
  },
  {
    slug: 'slack',
    name: 'Slack',
    kind: 'mcp_server',
    desc: 'Messages and channels',
    label: '2.0.1',
    spec: 'oauth',
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    kind: 'mcp_server',
    desc: 'Errors, events and releases',
    label: '4.3.0',
    spec: 'oauth',
    risk: 'medium',
  },
  {
    slug: 'release-notes',
    name: 'Release notes',
    kind: 'plugin',
    desc: 'Drafts notes from merged PRs',
    label: '1.4.0',
    spec: 'none',
  },
  {
    slug: 'incident-kit',
    name: 'Incident kit',
    kind: 'plugin',
    desc: 'Triage, timelines, postmortems',
    label: '2.0.0',
    spec: 'none',
    risk: 'medium',
    extraDraft: '2.1.0',
  },
  {
    slug: 'data-helpers',
    name: 'Data helpers',
    kind: 'plugin',
    desc: 'Warehouse queries with guardrails',
    label: '1.1.0',
    spec: 'none',
  },
  {
    slug: 'api-style',
    name: 'API style',
    kind: 'skill',
    desc: 'House rules for REST and events',
    label: '1.0.0',
    spec: 'none',
  },
  {
    slug: 'test-writer',
    name: 'Test writer',
    kind: 'plugin',
    desc: 'Generates and runs unit tests',
    label: '0.8.0',
    spec: 'none',
  },
  {
    slug: 'security-review',
    name: 'Security review',
    kind: 'plugin',
    desc: 'Checks diffs against our policy',
    label: '1.0.0',
    spec: 'none',
  },
  {
    slug: 'notion',
    name: 'Notion',
    kind: 'mcp_server',
    desc: 'Pages and databases',
    label: '1.0.4',
    spec: 'userSecret',
    secret: { name: 'NOTION_API_KEY', label: 'Notion API key' },
  },
  {
    slug: 'filesystem',
    name: 'Filesystem',
    kind: 'mcp_server',
    desc: 'Read and write files in a scratch workspace',
    label: '0.6.2',
    spec: 'package',
    pkg: {
      runtime: 'npm',
      identifier: '@modelcontextprotocol/server-filesystem',
      version: '0.6.2',
      egress: [],
    },
  },
  {
    slug: 'web-fetch',
    name: 'Web fetch',
    kind: 'mcp_server',
    desc: 'Fetch a web page as Markdown',
    label: '2025.4.1',
    spec: 'package',
    pkg: {
      runtime: 'pypi',
      identifier: 'mcp-server-fetch',
      version: '2025.4.1',
      egress: ['*.wikipedia.org', 'docs.acme.dev'],
    },
  },
  {
    slug: 'servicedesk',
    name: 'ServiceDesk',
    kind: 'mcp_server',
    desc: 'IT requests and approvals',
    label: '1.0.0',
    spec: 'oauth',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    kind: 'mcp_server',
    desc: 'Contacts, companies and deals',
    label: '3.1.0',
    spec: 'userSecret',
    secret: { name: 'HUBSPOT_API_KEY', label: 'API key' },
  },
  {
    slug: 'ticket-triage',
    name: 'Ticket triage',
    kind: 'mcp_server',
    desc: 'Internal triage helpers',
    label: '0.9.0',
    spec: 'package',
    pkg: { runtime: 'pypi', identifier: 'acme-ticket-triage', version: '0.9.0', egress: [] },
  },
];

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
                environmentVariables: [
                  { name: 'DATABASE_URL', value: '{{secret.DATABASE_URL}}', isRequired: true },
                ],
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
          approvals[v.id] = { approvedBy: 'u-dana', approvedAt: published, note: null };
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
      catalogEntryId: 'c-jira',
      target: { all: true },
      mode: 'default',
      scope: 'user',
      applyToExisting: true,
      enabled: true,
      createdBy: 'u-dana',
      createdAt: iso(now - 20 * DAY),
      updatedAt: iso(now - 20 * DAY),
    },
    {
      id: 'ap-2',
      catalogEntryId: 'c-postgres',
      target: { teamIds: ['t-data', 't-analytics'] },
      mode: 'required',
      scope: 'team',
      applyToExisting: true,
      enabled: true,
      createdBy: 'u-dana',
      createdAt: iso(now - 10 * DAY),
      updatedAt: iso(now - 10 * DAY),
    },
  ];
  return { entries, versions, autoInstall, files, approvals, testStarts: {} };
};

// --- helpers ------------------------------------------------------------------------------------------------------

const data = () => getDb().data.catalog;
const isRole = (...roles: string[]) => roles.includes(getDb().role);
const now = () => new Date().toISOString();

const entryOf = (id: string) => data().entries.find((e) => e.id === id);
const versionOf = (entryId: string, versionId: string) =>
  data().versions.find((v) => v.entryId === entryId && v.id === versionId);

const validation = (errors: { path: string; message: string }[]) =>
  problem(422, 'validation_failed', 'Some fields need attention', undefined, errors);

/** Files of a plugin or skill version (25.2): who must approve, and the diff against the last approved version. */
const approvalOf = (v: Version): Schemas['CatalogVersionDetail']['approval'] => {
  const executables = data().files.filter(
    (f) => f.versionId === v.id && f.classification === 'executable',
  );
  const stored = data().approvals[v.id];
  return {
    status: executables.length === 0 ? 'not-required' : stored ? 'approved' : 'pending',
    reviewedDiffSha256: 'a'.repeat(64),
    executables: executables.map((f) => ({ path: f.path })),
    diff: executables.map((f) => ({ path: f.path, change: 'added' as const, after: f.content })),
  };
};

const fileRow = (f: FileRecord): Schemas['CatalogFile'] => ({
  id: `${f.versionId}:${f.path}`,
  path: f.path,
  mode: f.mode,
  classification: f.classification,
  sha256: '0'.repeat(64),
  size: f.content.length,
  updatedAt: f.updatedAt,
});

/** A running test finishes a moment after it started (11.2); the version row then carries the passing run. */
const settle = (v: Version): void => {
  const started = data().testStarts[v.id];
  if (started && v.testResult?.status === 'running' && Date.now() - started > 1200) {
    v.testResult = passingRun(v.id, new Date(started).toISOString());
    delete data().testStarts[v.id];
  }
};

const detail = (v: Version): Schemas['CatalogVersionDetail'] => {
  settle(v);
  const files = data().files.some((f) => f.versionId === v.id);
  return files ? { ...v, approval: approvalOf(v) } : { ...v };
};

const needsPerUserSetup = (entryId: string): boolean => {
  const v = data().versions.find((x) => x.entryId === entryId && x.status === 'published');
  const mode = (v?.serverSpec?.auth as { mode?: string } | undefined)?.mode;
  return mode === 'userSecret' || mode === 'oauth';
};

/** Who an audience reaches, computed from the access slice like `computePreview` of the API (11.5). */
const previewOf = (
  entryId: string,
  p: Pick<Policy, 'target' | 'mode' | 'scope' | 'applyToExisting'>,
): Res<'post', '/auto-install-policies/{id}/preview'> => {
  const { users, teams } = getDb().data.access;
  const memberships = teams.flatMap((t) => t.members);
  const teamsOf = (userId: string) => memberships.filter((m) => m.userId === userId);
  const matched = users.filter((u) => {
    if (u.status === 'deactivated') return false;
    const t = p.target;
    if (t.all) return true;
    const mine = teamsOf(u.id);
    if (t.teamIds?.some((id) => mine.some((m) => m.teamId === id))) return true;
    if (
      t.roles?.some((r) =>
        r === 'manager' ? mine.some((m) => m.role === 'manager') : u.orgRole === r,
      )
    )
      return true;
    return false;
  });
  const byTeam = new Map<string, number>();
  for (const u of matched)
    for (const m of teamsOf(u.id)) byTeam.set(m.teamId, (byTeam.get(m.teamId) ?? 0) + 1);
  const willInstall = p.scope === 'team' ? byTeam.size : matched.length;
  const effective = p.applyToExisting || p.scope === 'team' ? willInstall : 0;
  const mustConnect = p.scope === 'user' && needsPerUserSetup(entryId) ? effective : 0;
  const summary = `${matched.length} ${matched.length === 1 ? 'person' : 'people'} in ${byTeam.size} ${byTeam.size === 1 ? 'team' : 'teams'} get this${
    mustConnect > 0 ? `; ${mustConnect} must connect their account` : ''
  }`;
  return {
    summary,
    users: matched.length,
    teams: byTeam.size,
    willInstall: effective,
    alreadyInstalled: 0,
    skippedRemoved: willInstall - effective,
    mustConnect,
    byTeam: [...byTeam].map(([teamId, n]) => ({
      teamId,
      slug: teams.find((t) => t.id === teamId)?.slug ?? null,
      users: n,
    })),
    sample: matched.slice(0, 12).map((u) => ({ userId: u.id, displayName: u.displayName })),
  };
};

// --- handlers ------------------------------------------------------------------------------------------------------

type EntryCreate = Body<'post', '/catalog'>;
type VersionCreate = Body<'post', '/catalog/{id}/versions'>;

export const catalogHandlers: HttpHandler[] = [
  route.get('/catalog', ({ query, url }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    const text = (query.q ?? '').toLowerCase();
    const rows = data().entries.filter(
      (e) =>
        (!query.kind || e.kind === query.kind) &&
        (!query.status || e.status === query.status) &&
        (!query.ownerTeamId || e.ownerTeamId === query.ownerTeamId) &&
        (!text || `${e.displayName} ${e.slug}`.toLowerCase().includes(text)),
    );
    return HttpResponse.json(pageOf(rows, url));
  }),

  route.post('/catalog', async ({ body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const input: EntryCreate = await body();
    const errors: { path: string; message: string }[] = [];
    if (!input.displayName?.trim()) errors.push({ path: '/displayName', message: 'Required' });
    if (!input.slug) errors.push({ path: '/slug', message: 'Required' });
    if (input.slug && (input.slug.length > 63 || slugify(input.slug, 63) !== input.slug))
      errors.push({
        path: '/slug',
        message: 'Use lowercase letters, digits and dashes (up to 63)',
      });
    if (errors.length) return validation(errors);
    if (data().entries.some((e) => e.slug === input.slug))
      return problem(409, 'conflict', 'A catalog entry with this slug already exists');
    const at = now();
    const entry: Entry = {
      id: nextId('c'),
      slug: input.slug,
      kind: input.kind ?? 'mcp_server',
      displayName: input.displayName.trim(),
      description: input.description ?? '',
      tags: input.tags ?? [],
      ownerTeamId: input.ownerTeamId ?? null,
      visibility: {
        org: input.visibility?.org ?? false,
        teamIds: input.visibility?.teamIds ?? [],
        userIds: input.visibility?.userIds ?? [],
      },
      status: 'draft',
      risk: input.risk ?? 'medium',
      source: { kind: 'manual' },
      currentVersionId: null,
      autoUpgrade: input.autoUpgrade ?? true,
      userOverrides: input.userOverrides ?? 'cosmetic',
      onDrift: input.onDrift ?? 'hideChanged',
      createdBy: getDb().me.id,
      createdAt: at,
      updatedAt: at,
    };
    data().entries.unshift(entry);
    return HttpResponse.json(entry, { status: 201, headers: etagHeaders(entry.updatedAt) });
  }),

  route.get('/catalog/{id}', ({ params }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    const e = entryOf(params.id);
    return e
      ? HttpResponse.json(e, { headers: etagHeaders(e.updatedAt) })
      : notFound('Catalog entry');
  }),

  route.patch('/catalog/{id}', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const e = entryOf(params.id);
    if (!e) return notFound('Catalog entry');
    const patch = await body();
    if (Object.keys(patch).length === 0)
      return validation([{ path: '/', message: 'at least one field is required' }]);
    if (patch.displayName !== undefined && !patch.displayName.trim())
      return validation([{ path: '/displayName', message: 'Required' }]);
    const { status, visibility, ...rest } = patch;
    Object.assign(e, rest, status ? { status } : {}, {
      ...(visibility
        ? {
            visibility: {
              org: visibility.org ?? false,
              teamIds: visibility.teamIds ?? [],
              userIds: visibility.userIds ?? [],
            },
          }
        : {}),
      updatedAt: now(),
    });
    return HttpResponse.json(e, { headers: etagHeaders(e.updatedAt) });
  }),

  route.get('/catalog/{id}/versions', ({ params, url }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    if (!entryOf(params.id)) return notFound('Catalog entry');
    const rows = data()
      .versions.filter((v) => v.entryId === params.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    rows.forEach(settle);
    return HttpResponse.json(pageOf(rows, url));
  }),

  route.post('/catalog/{id}/versions', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const e = entryOf(params.id);
    if (!e) return notFound('Catalog entry');
    const input: VersionCreate = await body();
    if (!input.label?.trim()) return validation([{ path: '/label', message: 'Required' }]);
    if (data().versions.some((v) => v.entryId === e.id && v.label === input.label))
      return problem(409, 'conflict', `Version ${input.label} already exists`);
    const at = now();
    const v: Version = {
      id: nextId('v'),
      entryId: e.id,
      label: input.label,
      serverSpec: (input.serverSpec ?? null) as Version['serverSpec'],
      overrides: { version: 1 },
      guardProfileId: null,
      limits: [],
      installForm: {
        variables: input.installForm?.variables ?? [],
        secrets: input.installForm?.secrets ?? [],
      },
      lockfile: null,
      referenceSnapshotId: null,
      protocolEra: null,
      testResult: null,
      runtime: {},
      status: 'draft',
      changelog: input.changelog ?? null,
      createdBy: getDb().me.id,
      createdAt: at,
      publishedAt: null,
      updatedAt: at,
    };
    data().versions.unshift(v);
    return HttpResponse.json(v, { status: 201, headers: etagHeaders(v.updatedAt) });
  }),

  route.get('/catalog/{id}/versions/{vid}', ({ params }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    const v = versionOf(params.id, params.vid);
    return v
      ? HttpResponse.json(detail(v), { headers: etagHeaders(v.updatedAt) })
      : notFound('Version');
  }),

  route.patch('/catalog/{id}/versions/{vid}', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const v = versionOf(params.id, params.vid);
    if (!v) return notFound('Version');
    if (v.status !== 'draft')
      return problem(409, 'version_immutable', 'Published versions cannot be edited');
    const patch = await body();
    if (patch.label !== undefined && !patch.label.trim())
      return validation([{ path: '/label', message: 'Required' }]);
    if (
      patch.label &&
      data().versions.some(
        (x) => x.entryId === v.entryId && x.id !== v.id && x.label === patch.label,
      )
    )
      return problem(409, 'conflict', `Version ${patch.label} already exists`);
    if (patch.label !== undefined) v.label = patch.label;
    if (patch.serverSpec !== undefined) {
      v.serverSpec = patch.serverSpec as Version['serverSpec'];
      v.testResult = null; // any change to the spec invalidates the test (11.2)
    }
    if (patch.installForm) {
      v.installForm = {
        variables: patch.installForm.variables ?? v.installForm.variables,
        secrets: patch.installForm.secrets ?? v.installForm.secrets,
      };
    }
    if (patch.changelog !== undefined) v.changelog = patch.changelog;
    v.updatedAt = now();
    return HttpResponse.json(v, { headers: etagHeaders(v.updatedAt) });
  }),

  route.post('/catalog/{id}/versions/{vid}/test', ({ params }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const v = versionOf(params.id, params.vid);
    if (!v) return notFound('Version');
    const startedAt = now();
    data().testStarts[v.id] = Date.now();
    const run: Run = {
      id: nextId('run'),
      versionId: v.id,
      status: 'running',
      startedAt,
      finishedAt: null,
      steps: [
        { id: 'prepare', status: 'passed', detail: 'npx -y …' },
        { id: 'connect', status: 'running' },
      ],
    };
    v.testResult = run;
    return HttpResponse.json(run, { status: 202 });
  }),

  route.post('/catalog/{id}/versions/{vid}/publish', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const e = entryOf(params.id);
    const v = versionOf(params.id, params.vid);
    if (!e || !v) return notFound('Version');
    if (v.status !== 'draft')
      return problem(409, 'version_immutable', 'Published versions cannot be edited');
    settle(v);
    if (v.testResult?.status !== 'passed') {
      return problem(
        409,
        'test_required',
        'Run a passing test first',
        'Publishing needs a passing test of this exact version.',
      );
    }
    if (data().files.some((f) => f.versionId === v.id)) {
      const status = approvalOf(v)?.status;
      if (status !== 'approved' && status !== 'not-required')
        return problem(
          409,
          'approval_required',
          'An Admin must approve the executable content first',
        );
    }
    const given = await body().catch(() => undefined);
    const at = now();
    v.status = 'published';
    v.publishedAt = at;
    v.updatedAt = at;
    e.status = 'published';
    e.currentVersionId = v.id;
    if (given?.visibility)
      e.visibility = {
        org: given.visibility.org ?? false,
        teamIds: given.visibility.teamIds ?? [],
        userIds: given.visibility.userIds ?? [],
      };
    e.updatedAt = at;
    return HttpResponse.json(v, { headers: etagHeaders(v.updatedAt) });
  }),

  route.post('/catalog/{id}/versions/{vid}/approve-executable', ({ params }) => {
    if (!isRole('admin')) return forbidden();
    const v = versionOf(params.id, params.vid);
    if (!v) return notFound('Version');
    const executables = data().files.filter(
      (f) => f.versionId === v.id && f.classification === 'executable',
    );
    if (executables.length === 0)
      return problem(409, 'approval_not_required', 'This version has no executable content');
    const at = now();
    data().approvals[v.id] = { approvedBy: getDb().me.id, approvedAt: at, note: null };
    return HttpResponse.json({
      id: v.id,
      updatedAt: at,
      catalogVersionId: v.id,
      approvedBy: getDb().me.id,
      reviewedDiffSha256: 'a'.repeat(64),
      note: null,
      approvedAt: at,
      status: 'approved' as const,
      paths: executables.map((f) => f.path),
    });
  }),

  route.get('/catalog/{id}/versions/{vid}/overrides', ({ params }) => {
    const e = entryOf(params.id);
    const v = versionOf(params.id, params.vid);
    if (!e || !v) return notFound('Version');
    return HttpResponse.json({
      doc: v.overrides,
      updatedAt: v.updatedAt,
      userOverrides: e.userOverrides,
      rejected: [],
    });
  }),

  route.put('/catalog/{id}/versions/{vid}/overrides', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const e = entryOf(params.id);
    const v = versionOf(params.id, params.vid);
    if (!e || !v) return notFound('Version');
    if (v.status !== 'draft')
      return problem(409, 'version_immutable', 'Published versions cannot be edited');
    v.overrides = await body();
    v.updatedAt = now();
    return HttpResponse.json({
      doc: v.overrides,
      updatedAt: v.updatedAt,
      userOverrides: e.userOverrides,
      rejected: [],
    });
  }),

  route.get('/catalog/{id}/versions/{vid}/files', ({ params }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    const v = versionOf(params.id, params.vid);
    if (!v) return notFound('Version');
    const files = data().files.filter((f) => f.versionId === v.id);
    return HttpResponse.json({
      items: files.map(fileRow).sort((a, b) => a.path.localeCompare(b.path)),
      nextCursor: null,
      approval: files.length ? (approvalOf(v) ?? null) : null,
    });
  }),

  route.get('/catalog/{id}/versions/{vid}/files/{path}', ({ params, request }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    const path = decodeURIComponent(new URL(request.url).pathname.replace(/^.*\/files\//, ''));
    const f = data().files.find((x) => x.versionId === params.vid && x.path === path);
    return f
      ? HttpResponse.json(
          {
            ...fileRow(f),
            contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode(f.content))),
          },
          { headers: etagHeaders(f.updatedAt) },
        )
      : notFound('File');
  }),

  route.put('/catalog/{id}/versions/{vid}/files/{path}', async ({ params, request, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const v = versionOf(params.id, params.vid);
    if (!v) return notFound('Version');
    if (v.status !== 'draft')
      return problem(409, 'version_immutable', 'Published versions cannot be edited');
    const path = decodeURIComponent(new URL(request.url).pathname.replace(/^.*\/files\//, ''));
    const input = await body();
    if (typeof input.contentBase64 !== 'string')
      return validation([{ path: '/contentBase64', message: 'Required' }]);
    const content = new TextDecoder().decode(
      Uint8Array.from(atob(input.contentBase64), (c) => c.charCodeAt(0)),
    );
    const mode = input.mode ?? 'file';
    const at = now();
    const existing = data().files.find((x) => x.versionId === v.id && x.path === path);
    const record: FileRecord = {
      versionId: v.id,
      path,
      mode,
      classification:
        mode === 'executable' || existing?.classification === 'executable' ? 'executable' : 'plain',
      content,
      updatedAt: at,
    };
    data().files = [...data().files.filter((x) => x !== existing), record];
    delete data().approvals[v.id]; // a changed file must be reviewed again (25.2)
    return HttpResponse.json(fileRow(record), { headers: etagHeaders(at) });
  }),

  route.get('/auto-install-policies', ({ url }) => {
    if (!isRole('admin', 'manager', 'auditor')) return forbidden();
    return HttpResponse.json(pageOf(data().autoInstall, url));
  }),

  route.post('/auto-install-policies', async ({ body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const input = await body();
    const errors: { path: string; message: string }[] = [];
    if (!input.catalogEntryId || !entryOf(input.catalogEntryId))
      errors.push({ path: '/catalogEntryId', message: 'Pick an existing catalog entry' });
    const t = input.target;
    if (
      !t ||
      !(
        t.all === true ||
        (t.teamIds?.length ?? 0) + (t.roles?.length ?? 0) + (t.idpGroups?.length ?? 0) > 0
      )
    )
      errors.push({
        path: '/target',
        message: 'the target must name all users, teams, roles or IdP groups',
      });
    if (errors.length) return validation(errors);
    const at = now();
    const p: Policy = {
      id: nextId('ap'),
      catalogEntryId: input.catalogEntryId,
      target: input.target,
      mode: input.mode ?? 'default',
      scope: input.scope ?? 'user',
      applyToExisting: input.applyToExisting ?? true,
      enabled: input.enabled ?? true,
      createdBy: getDb().me.id,
      createdAt: at,
      updatedAt: at,
    };
    data().autoInstall.push(p);
    return HttpResponse.json(p, { status: 201, headers: etagHeaders(at) });
  }),

  route.patch('/auto-install-policies/{id}', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const p = data().autoInstall.find((x) => x.id === params.id);
    if (!p) return notFound('Policy');
    const patch = await body();
    if (Object.keys(patch).length === 0)
      return validation([{ path: '/', message: 'at least one field is required' }]);
    Object.assign(p, patch, { updatedAt: now() });
    return HttpResponse.json(p, { headers: etagHeaders(p.updatedAt) });
  }),

  route.delete('/auto-install-policies/{id}', ({ params }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const before = data().autoInstall.length;
    data().autoInstall = data().autoInstall.filter((x) => x.id !== params.id);
    return data().autoInstall.length === before ? notFound('Policy') : noContent();
  }),

  route.post('/auto-install-policies/{id}/preview', async ({ params, body }) => {
    if (!isRole('admin', 'manager')) return forbidden();
    const p = data().autoInstall.find((x) => x.id === params.id);
    if (!p) return notFound('Policy');
    const changes = await body().catch(() => ({}));
    return HttpResponse.json(previewOf(p.catalogEntryId, { ...p, ...changes }));
  }),
];

// --- samples ------------------------------------------------------------------------------------------------------

const SPEC_SAMPLE = {
  type: 'package',
  runtime: 'npm',
  identifier: '@acme/example-mcp',
  version: '1.0.0',
  size: 'small',
  egress: { allow: ['api.example.com'] },
  environmentVariables: [{ name: 'REGION', value: '{{var.REGION}}', isRequired: true }],
  auth: { mode: 'none' },
} as const;

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const catalogSamples: SampleFactory = (db) => {
  const draft = db.data.catalog.versions.find((v) => v.id === 'v-postgres-3.2.0');
  const kit = db.data.catalog.versions.find((v) => v.id === 'v-incident-kit-2.1.0');
  const jira = 'c-jira';
  const v = `/catalog/c-postgres/versions/${draft?.id}`;
  const k = `/catalog/c-incident-kit/versions/${kit?.id}`;
  const samples: Sample[] = [
    { method: 'get', path: '/catalog' },
    { method: 'get', path: '/catalog?kind=plugin&q=incident' },
    {
      method: 'post',
      path: '/catalog',
      body: {
        slug: 'sample-server',
        kind: 'mcp_server',
        displayName: 'Sample server',
        description: 'A sample',
        visibility: { org: false, teamIds: ['t-data'], userIds: [] },
        risk: 'low',
        userOverrides: 'cosmetic',
        onDrift: 'hideChanged',
        autoUpgrade: true,
      },
    },
    { method: 'get', path: `/catalog/${jira}` },
    {
      method: 'patch',
      path: `/catalog/${jira}`,
      body: { description: 'Issues', risk: 'low', onDrift: 'warn' },
    },
    { method: 'get', path: `/catalog/${jira}/versions` },
    {
      method: 'post',
      path: `/catalog/${jira}/versions`,
      body: {
        label: '9.9.9',
        serverSpec: SPEC_SAMPLE,
        installForm: {
          variables: [{ name: 'REGION', label: 'Region', required: true }],
          secrets: [],
        },
        changelog: null,
      },
    },
    { method: 'get', path: v },
    { method: 'patch', path: v, body: { label: '3.2.1', serverSpec: SPEC_SAMPLE } },
    { method: 'post', path: `${v}/test` },
    {
      method: 'post',
      path: `${v}/publish`,
      body: { visibility: { org: true, teamIds: [], userIds: [] } },
    },
    { method: 'get', path: `${v}/overrides` },
    {
      method: 'put',
      path: `${v}/overrides`,
      body: { version: 1, tools: { pg_run_query: { hidden: true } } },
    },
    { method: 'get', path: `${k}/files` },
    { method: 'get', path: `${k}/files/SKILL.md` },
    {
      method: 'put',
      path: `${k}/files/references/notes.md`,
      body: { contentBase64: btoa('# Notes'), mode: 'file' },
    },
    { method: 'post', path: `${k}/approve-executable`, body: { note: 'Reviewed' } },
    { method: 'get', path: '/auto-install-policies' },
    {
      method: 'post',
      path: '/auto-install-policies',
      body: {
        catalogEntryId: jira,
        target: { teamIds: ['t-data'], roles: ['manager'], idpGroups: ['eng'] },
        mode: 'default',
        scope: 'user',
        applyToExisting: true,
        enabled: true,
      },
    },
    {
      method: 'patch',
      path: '/auto-install-policies/ap-1',
      body: { mode: 'required', enabled: false },
    },
    {
      method: 'post',
      path: '/auto-install-policies/ap-2/preview',
      body: { target: { all: true }, mode: 'default', scope: 'user', applyToExisting: true },
    },
    { method: 'delete', path: '/auto-install-policies/ap-1' },
  ];
  return samples;
};
