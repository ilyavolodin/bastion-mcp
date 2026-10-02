/**
 * MSW mock of the servers routes (installations, secrets, sign-in, capabilities, egress, overrides, try-it,
 * endpoints, client configuration, the store), typed by the generated OpenAPI types (see `../http.ts`). Rows are in
 * the shape of the API (`Schemas[...]`); `buildServersData` seeds the Acme installations, `serversHandlers` answer
 * from `getDb().data.servers` and read the catalog and access slices for entries, versions and people.
 */
import { isValidSlug, slugify, toolPrefixFromSlug } from '@bastion-mcp/core/ids';
import { sse } from 'msw';
import type { Body, Res, Schemas } from '@/api/schema';
import {
  etagHeaders,
  forbidden,
  HttpResponse,
  noContent,
  notFound,
  P,
  pageOf,
  problem,
  route,
  type Sample,
  type SampleFactory,
} from '../http';
import { ITEMS } from '../servers/definitions';
import {
  definitionsFor,
  documentErrors,
  previewFor,
  toUpstream,
  type Upstream,
} from '../servers/overrides-engine';
import { getDb, nextId } from '../state';

type Installation = Schemas['Installation'];
type Endpoint = Schemas['Endpoint'];
type EgressEntry = Schemas['EgressEntry'];

export type ServersData = {
  installations: Installation[];
  endpoints: Endpoint[];
  /** Recent egress decisions of the sandboxes, by installation id. */
  egress: Record<string, EgressEntry[]>;
  /** Upstream definitions the servers list, by installation id (what the router reads from the instance). */
  upstream: Record<string, Upstream>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ME = 'u-dana';

// --- seed ---------------------------------------------------------------------------------------------------------

type Seed = {
  id: string;
  entry: string;
  slug: string;
  name: string;
  version: string;
  status: Installation['status'];
  /** `u-...` or `t-...` */
  owner: string;
  detail?: string;
  variables?: Record<string, string>;
  secrets?: string[];
  overrides?: Record<string, unknown>;
};

const SEEDS: Seed[] = [
  {
    id: 'i-github',
    entry: 'github',
    slug: 'github',
    name: 'GitHub',
    version: '2.4.0',
    status: 'needs_setup',
    owner: ME,
  },
  {
    id: 'i-jira',
    entry: 'jira',
    slug: 'jira',
    name: 'Jira',
    version: '1.8.2',
    status: 'ready',
    owner: ME,
    variables: { SITE_URL: 'https://acme.atlassian.net' },
  },
  {
    id: 'i-linear',
    entry: 'linear',
    slug: 'linear',
    name: 'Linear',
    version: '1.2.0',
    status: 'ready',
    owner: 't-platform',
  },
  {
    id: 'i-postgres',
    entry: 'postgres',
    slug: 'pg-analytics',
    name: 'Postgres analytics',
    version: '3.2.0',
    status: 'ready',
    owner: 't-data',
    secrets: ['DATABASE_URL'],
    overrides: {
      version: 1,
      tools: {
        pg_run_query: {
          description: { mode: 'append', text: 'Queries run on the analytics replica.' },
          annotations: { readOnlyHint: true },
        },
        pg_describe_table: { title: 'Describe a table' },
        pg_write_rows: { hidden: true },
      },
    },
  },
  {
    id: 'i-sentry',
    entry: 'sentry',
    slug: 'sentry',
    name: 'Sentry',
    version: '4.3.0',
    status: 'reconnect_required',
    owner: ME,
  },
  {
    id: 'i-slack',
    entry: 'slack',
    slug: 'slack',
    name: 'Slack',
    version: '2.0.1',
    status: 'ready',
    owner: ME,
  },
  {
    id: 'i-notion',
    entry: 'notion',
    slug: 'notion',
    name: 'Notion',
    version: '1.0.4',
    status: 'needs_setup',
    owner: ME,
  },
  {
    id: 'i-filesystem',
    entry: 'filesystem',
    slug: 'filesystem',
    name: 'Filesystem',
    version: '0.6.2',
    status: 'error',
    owner: ME,
    detail: 'The server exited with code 1 while starting.',
  },
  {
    id: 'i-zendesk',
    entry: 'zendesk',
    slug: 'zendesk',
    name: 'Zendesk',
    version: '1.1.0',
    status: 'ready',
    owner: ME,
    secrets: ['ZENDESK_TOKEN'],
  },
  {
    id: 'i-webfetch',
    entry: 'web-fetch',
    slug: 'web-fetch',
    name: 'Web fetch',
    version: '2025.4.1',
    status: 'ready',
    owner: ME,
  },
];

const secretRef = (installation: string, name: string, scope: 'user' | 'team') => ({
  scope,
  name: `${installation}.${name}`,
  version: 1,
});

export const buildServersData = (now: number): ServersData => {
  const created = iso(now - 20 * DAY);
  const installations: Installation[] = SEEDS.map((s) => {
    const team = s.owner.startsWith('t-');
    return {
      id: s.id,
      ownerType: team ? 'team' : 'user',
      ownerId: s.owner,
      catalogEntryId: `c-${s.entry}`,
      catalogVersionId: `v-${s.entry}-${s.version}`,
      pinnedVersion: false,
      personalSpec: null,
      slug: s.slug,
      toolPrefix: toolPrefixFromSlug(s.slug),
      displayName: s.name,
      enabled: s.status !== 'error',
      variables: s.variables ?? {},
      secretRefs: Object.fromEntries(
        (s.secrets ?? []).map((n) => [n, secretRef(s.id, n, team ? 'team' : 'user')]),
      ),
      overrides: s.overrides ?? {},
      origin: 'catalog',
      status: s.status,
      statusDetail: s.detail ? { code: 'start_failed', message: s.detail } : null,
      createdAt: created,
      updatedAt: iso(now - DAY),
    };
  });

  const endpoint = (
    id: string,
    slug: string,
    displayName: string,
    installationIds: string[],
    ageDays: number,
  ): Endpoint => ({
    id,
    ownerType: 'user',
    ownerId: ME,
    slug,
    displayName,
    installationIds,
    prefixMode: 'always',
    instructions: null,
    createdAt: iso(now - ageDays * DAY),
    updatedAt: iso(now - ageDays * DAY),
  });

  const egress: ServersData['egress'] = {
    'i-postgres': [
      { ts: iso(now - HOUR), host: 'warehouse.acme.internal', port: 5432, decision: 'allowed' },
      { ts: iso(now - 3 * HOUR), host: 'registry.npmjs.org', port: 443, decision: 'allowed' },
      { ts: iso(now - 2 * HOUR), host: 'telemetry.example.net', port: 443, decision: 'denied' },
    ],
    'i-filesystem': [
      { ts: iso(now - 5 * HOUR), host: 'registry.npmjs.org', port: 443, decision: 'allowed' },
    ],
    'i-webfetch': [
      { ts: iso(now - HOUR), host: 'en.wikipedia.org', port: 443, decision: 'allowed' },
      { ts: iso(now - 4 * HOUR), host: 'docs.acme.dev', port: 443, decision: 'allowed' },
    ],
  };

  return {
    installations,
    endpoints: [
      endpoint('e-eng', 'engineering', 'Engineering', ['i-github', 'i-jira', 'i-linear'], 9),
      endpoint('e-support', 'support', 'Support', ['i-zendesk', 'i-jira'], 4),
    ],
    egress,
    upstream: Object.fromEntries(
      SEEDS.map((s) => [s.id, toUpstream(ITEMS[s.entry] ?? [])] as const),
    ),
  };
};

// --- helpers ------------------------------------------------------------------------------------------------------

const data = () => getDb().data.servers;
const catalog = () => getDb().data.catalog;
const isRole = (...roles: string[]) => roles.includes(getDb().role);
const nowIso = () => new Date().toISOString();

const validation = (errors: { path: string; message: string }[]) =>
  problem(422, 'validation_failed', 'Some fields need attention', undefined, errors);

/** Members and auditors manage only their own installations; managers also their teams'; admins all. */
const canManage = (i: Installation): boolean => {
  if (isRole('admin')) return true;
  if (i.ownerType === 'user') return i.ownerId === ME;
  return (
    i.ownerType === 'team' &&
    getDb().me.teams.some((t) => t.id === i.ownerId && t.role === 'manager')
  );
};

const installationOf = (id: string) => data().installations.find((i) => i.id === id);
const visibleInstallation = (id: string) => {
  const row = installationOf(id);
  return row && canManage(row) ? row : undefined;
};

/** `If-Match` is required on a change and must name the row's current version (17.1). */
const checkVersion = (request: Request, row: { updatedAt: string }) => {
  const given = request.headers.get('if-match');
  if (!given) return problem(428, 'precondition_required', 'If-Match is required');
  if (given.trim() === '*' || given.replace(/^W\//, '').replace(/"/g, '') === row.updatedAt)
    return null;
  return problem(412, 'precondition_failed', 'The resource was modified; reload and retry');
};

const entryOf = (installation: Installation) =>
  catalog().entries.find((e) => e.id === installation.catalogEntryId);
const versionOfInstallation = (installation: Installation) =>
  catalog().versions.find((v) => v.id === installation.catalogVersionId);

const specOf = (installation: Installation): Record<string, unknown> | null =>
  installation.personalSpec ?? versionOfInstallation(installation)?.serverSpec ?? null;

const authModeOf = (installation: Installation): string => {
  const auth = specOf(installation)?.auth;
  return typeof auth === 'object' && auth !== null && 'mode' in auth ? String(auth.mode) : 'none';
};

const layersOf = (installation: Installation): (Record<string, unknown> | undefined)[] => [
  versionOfInstallation(installation)?.overrides,
  installation.overrides,
];

// --- client configuration (11.4) ----------------------------------------------------------------------------------

type ClientKind = 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode';
const CLIENT_KINDS: readonly string[] = ['claude-desktop', 'claude-code', 'cursor', 'vscode'];
type ClientConfig = Res<'get', '/client-config'>;

const PAT = '<your Bastion personal access token>';

const clientConfig = (
  client: ClientKind,
  url: string,
  name: string,
  auth: 'oauth' | 'pat',
): ClientConfig => {
  const base = { client, url, name, auth } as const;
  switch (client) {
    case 'claude-desktop':
      return {
        ...base,
        file: 'claude_desktop_config.json',
        config: {
          mcpServers: {
            [name]: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                url,
                ...(auth === 'pat'
                  ? [
                      '--header', // biome-ignore lint/suspicious/noTemplateCurlyInString: the client expands ${BASTION_AUTH} itself
                      'Authorization:${BASTION_AUTH}',
                    ]
                  : []),
              ],
              ...(auth === 'pat' ? { env: { BASTION_AUTH: `Bearer ${PAT}` } } : {}),
            },
          },
        },
        instructions: [
          'Preferred: Settings > Connectors > Add custom connector, and paste the URL; Claude opens the Bastion sign-in.',
          'Alternative for the local config file: add the block to claude_desktop_config.json and restart Claude Desktop.',
          'The mcp-remote bridge needs Node.js 20 or later.',
        ],
      };
    case 'claude-code':
      return {
        ...base,
        command: `claude mcp add --transport http ${name} ${url}${auth === 'pat' ? ` --header "Authorization: Bearer ${PAT}"` : ''}`,
        instructions: [
          'Run the command once in a terminal.',
          'Then run /mcp in Claude Code and sign in.',
        ],
      };
    case 'cursor':
      return {
        ...base,
        file: '~/.cursor/mcp.json',
        config: {
          mcpServers: {
            [name]: {
              url,
              ...(auth === 'pat' ? { headers: { Authorization: `Bearer ${PAT}` } } : {}),
            },
          },
        },
        instructions: ['Save the block as ~/.cursor/mcp.json and reload Cursor.'],
      };
    case 'vscode':
      return {
        ...base,
        file: '.vscode/mcp.json',
        config: {
          servers: {
            [name]: {
              type: 'http',
              url,
              ...(auth === 'pat' ? { headers: { Authorization: `Bearer ${PAT}` } } : {}),
            },
          },
        },
        instructions: ['Save the block as .vscode/mcp.json in your workspace.'],
      };
  }
};

const clientQuery = (url: URL) => {
  const client = url.searchParams.get('client') ?? '';
  const auth = url.searchParams.get('auth') ?? 'oauth';
  if (!CLIENT_KINDS.includes(client) || !['oauth', 'pat'].includes(auth)) {
    return null;
  }
  return { client: client as ClientKind, auth: auth as 'oauth' | 'pat' };
};

// --- the store (11.1) ---------------------------------------------------------------------------------------------

const visibleInStore = (e: Schemas['CatalogEntry']): boolean => {
  if (e.status !== 'published') return false;
  if (isRole('admin')) return true;
  const mine = getDb().me.teams.map((t) => t.id);
  return (
    e.visibility.org ||
    e.visibility.userIds.includes(ME) ||
    e.visibility.teamIds.some((t) => mine.includes(t)) ||
    (e.ownerTeamId !== null && mine.includes(e.ownerTeamId))
  );
};

const storeRow = (e: Schemas['CatalogEntry']): Schemas['StoreEntry'] => ({
  id: e.id,
  slug: e.slug,
  kind: e.kind,
  displayName: e.displayName,
  description: e.description,
  tags: e.tags,
  risk: e.risk,
  ownerTeamId: e.ownerTeamId,
  currentVersionId: e.currentVersionId,
  updatedAt: e.updatedAt,
});

// --- handlers -----------------------------------------------------------------------------------------------------

type CreateBody = Body<'post', '/installations'>;

export const serversHandlers = [
  // --- installations ----------------------------------------------------------------------------------------------
  route.get('/installations', ({ url }) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const status = url.searchParams.get('status');
    const rows = data()
      .installations.filter(canManage)
      .filter((i) => (status ? i.status === status : true))
      .filter((i) => (q ? `${i.displayName} ${i.slug}`.toLowerCase().includes(q) : true));
    return HttpResponse.json(pageOf(rows, url));
  }),

  route.post('/installations', async ({ body }) => {
    const input: CreateBody = await body();
    const db = getDb();
    const team = input.ownerType === 'team';
    const entry = input.catalogEntryId
      ? catalog().entries.find((e) => e.id === input.catalogEntryId)
      : undefined;
    if ((input.catalogEntryId === undefined) === (input.personalSpec === undefined)) {
      return validation([
        { path: '/', message: 'give exactly one of catalogEntryId and personalSpec' },
      ]);
    }
    if (team && !input.teamId) {
      return validation([
        { path: '/teamId', message: 'teamId is required for team installations' },
      ]);
    }
    if (team && !input.catalogEntryId) {
      return validation([
        { path: '/catalogEntryId', message: 'team installations come from a catalog entry' },
      ]);
    }
    if (
      team &&
      !(isRole('admin') || db.me.teams.some((t) => t.id === input.teamId && t.role === 'manager'))
    ) {
      return forbidden();
    }
    if (input.catalogEntryId && !entry) return notFound('Catalog entry');
    const versionId = input.catalogVersionId ?? entry?.currentVersionId ?? null;
    if (entry && !versionId) {
      return problem(409, 'no_published_version', 'The catalog entry has no published version');
    }
    const version = versionId ? catalog().versions.find((v) => v.id === versionId) : undefined;
    if (entry && (!version || version.entryId !== entry.id)) return notFound('Catalog version');
    if (version && version.status !== 'published') {
      return problem(409, 'version_not_published', 'Only published versions can be installed');
    }
    const slug = input.slug ?? slugify(entry?.slug ?? input.displayName ?? 'server');
    if (!isValidSlug(slug))
      return validation([{ path: '/slug', message: 'at least 2 characters' }]);
    const ownerId = team ? (input.teamId ?? '') : ME;
    if (
      data().installations.some(
        (i) => i.ownerType === (team ? 'team' : 'user') && i.ownerId === ownerId && i.slug === slug,
      )
    ) {
      return problem(409, 'slug_collision', 'An installation with this slug exists');
    }
    const spec = input.personalSpec ?? version?.serverSpec ?? null;
    const auth =
      typeof spec?.auth === 'object' && spec.auth ? (spec.auth as { mode?: string }).mode : 'none';
    const row: Installation = {
      id: nextId('i'),
      ownerType: team ? 'team' : 'user',
      ownerId,
      catalogEntryId: entry?.id ?? null,
      catalogVersionId: version?.id ?? null,
      pinnedVersion: input.pinnedVersion ?? false,
      personalSpec: input.personalSpec ?? null,
      slug,
      toolPrefix: input.toolPrefix ?? toolPrefixFromSlug(slug),
      displayName: input.displayName ?? entry?.displayName ?? slug,
      enabled: true,
      variables: input.variables ?? {},
      secretRefs: {},
      overrides: {},
      origin: entry ? 'catalog' : 'personal',
      // The worker decides the real status once the server runs; the demo shows what is still to do.
      status: auth === 'oauth' || auth === 'userSecret' ? 'needs_setup' : 'ready',
      statusDetail: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data().installations.push(row);
    data().upstream[row.id] = toUpstream(ITEMS[entry?.slug ?? ''] ?? []);
    return HttpResponse.json(row, { status: 201, headers: etagHeaders(row.updatedAt) });
  }),

  route.get('/installations/{id}', ({ params }) => {
    const row = visibleInstallation(params.id);
    return row
      ? HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) })
      : notFound('Installation');
  }),

  route.patch('/installations/{id}', async ({ params, request, body }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    const patch = await body();
    if (Object.keys(patch).length === 0) {
      return validation([{ path: '/', message: 'at least one field is required' }]);
    }
    const errors: { path: string; message: string }[] = [];
    if (patch.displayName !== undefined && !patch.displayName.trim()) {
      errors.push({
        path: '/displayName',
        message: 'Too small: expected string to have >=1 characters',
      });
    }
    if (
      patch.toolPrefix !== undefined &&
      (patch.toolPrefix.length < 1 || patch.toolPrefix.length > 40)
    ) {
      errors.push({ path: '/toolPrefix', message: 'must be 1 to 40 characters' });
    }
    if (errors.length) return validation(errors);
    if (patch.catalogVersionId !== undefined) {
      const v = catalog().versions.find((x) => x.id === patch.catalogVersionId);
      if (!v || v.entryId !== row.catalogEntryId) return notFound('Catalog version');
      if (v.status !== 'published') {
        return problem(409, 'version_not_published', 'Only published versions can be installed');
      }
    }
    Object.assign(row, patch, { updatedAt: nowIso() });
    if (patch.enabled === false) row.status = 'disabled';
    else if (patch.enabled === true && row.status === 'disabled') row.status = 'ready';
    return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
  }),

  route.delete('/installations/{id}', ({ params, request }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    data().installations = data().installations.filter((i) => i.id !== row.id);
    for (const e of data().endpoints) {
      e.installationIds = e.installationIds.filter((id) => id !== row.id);
    }
    return noContent();
  }),

  route.post('/installations/{id}/restart', ({ params }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    if (row.status === 'error') row.status = 'ready';
    return HttpResponse.json({ ok: true as const });
  }),

  route.post('/installations/{id}/connect', ({ params }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    // The demo finishes the sign-in at once; the real server answers with the upstream's authorization URL.
    if (row.status === 'needs_setup' || row.status === 'reconnect_required') {
      row.status = 'ready';
      row.updatedAt = nowIso();
    }
    return HttpResponse.json({
      authorizationUrl: `${getDb().me.org.baseUrl}/oauth/upstream/${row.slug}/authorize?state=demo`,
    });
  }),

  route.delete('/installations/{id}/connection', ({ params }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    row.status = row.enabled ? 'reconnect_required' : 'disabled';
    row.updatedAt = nowIso();
    return noContent();
  }),

  route.put('/installations/{id}/secrets/{name}', async ({ params, body }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(params.name)) {
      return validation([{ path: '/name', message: 'Invalid secret name' }]);
    }
    const { value } = await body();
    if (!value || value.length > 65_536) {
      return validation([
        { path: '/value', message: 'Too small: expected string to have >=1 characters' },
      ]);
    }
    const scope = row.ownerType === 'user' ? 'user' : 'team';
    const previous = row.secretRefs[params.name] as { version?: number } | undefined;
    const version = (previous?.version ?? 0) + 1;
    row.secretRefs = {
      ...row.secretRefs,
      [params.name]: { scope, name: `${row.id}.${params.name}`, version },
    };
    row.updatedAt = nowIso();
    if (row.status === 'needs_setup' && authModeOf(row) === 'userSecret') row.status = 'ready';
    return HttpResponse.json({
      name: `${row.id}.${params.name}`,
      scope,
      version,
      updatedAt: row.updatedAt,
    });
  }),

  // --- what a server serves ----------------------------------------------------------------------------------------
  ...(['tools', 'prompts', 'resources', 'templates'] as const).map((what) =>
    route.get(`/installations/{id}/${what}`, ({ params }) => {
      const row = visibleInstallation(params.id);
      if (!row) return notFound('Installation');
      const kind = (
        {
          tools: 'tool',
          prompts: 'prompt',
          resources: 'resource',
          templates: 'resourceTemplate',
        } as const
      )[what];
      const out = definitionsFor(
        kind,
        data().upstream[row.id] ?? toUpstream([]),
        layersOf(row),
        row.status === 'reconnect_required' ? row.slug : null,
      );
      return HttpResponse.json({
        ...out,
        meta: out.meta.map((m) => ({ ...m, installationId: row.id })),
      });
    }),
  ),

  route.get('/installations/{id}/egress', ({ params }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    return HttpResponse.json({ items: data().egress[row.id] ?? [], nextCursor: null });
  }),

  route.post('/installations/{id}/try', async ({ params, body }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const input = await body();
    if (input.kind !== 'tool') {
      return HttpResponse.json({
        result: { contents: [] },
        isError: false,
        durationMs: 24,
        callId: null,
      });
    }
    const tools = definitionsFor(
      'tool',
      data().upstream[row.id] ?? toUpstream([]),
      layersOf(row),
      null,
    ).items;
    if (!tools.some((t) => t.name === input.name)) {
      return HttpResponse.json({
        result: { content: [{ type: 'text', text: `Unknown tool: ${input.name}` }], isError: true },
        isError: true,
        durationMs: 3,
        callId: null,
      });
    }
    const rows = [
      { id: 1, orders: 482, region: 'emea' },
      { id: 2, orders: 311, region: 'apac' },
    ];
    return HttpResponse.json({
      result: {
        content: [{ type: 'text', text: `${rows.length} rows` }],
        structuredContent: { rows, rowCount: rows.length },
        isError: false,
      },
      isError: false,
      durationMs: 142,
      callId: nextId('call'),
    });
  }),

  // The stderr tail is a Server-Sent Events stream, so it is not an operation with a JSON body: each `log` event
  // carries `{ line }` as JSON (routes/installations.ts).
  sse(P('/installations/:id/logs'), ({ client, request }) => {
    const lines = [
      'npx -y @acme/pg-mcp@3.2.0',
      'pg-mcp listening on stdio · protocol 2025-11-25',
      'connected to warehouse.acme.internal:5432',
      'query ok rows=214 elapsed=41ms',
      'warn: DATABASE_URL uses a read-write role; consider analytics_ro',
    ];
    const send = (line: string) =>
      (client.send as (m: { event: string; data: string }) => void)({
        event: 'log',
        data: JSON.stringify({ line }),
      });
    let i = 0;
    send(lines[0] ?? '');
    const timer = setInterval(() => {
      send(`${new Date().toISOString().slice(11, 19)} ${lines[++i % lines.length]}`);
    }, 2500);
    request.signal.addEventListener('abort', () => clearInterval(timer));
  }),

  // --- overrides (12) ------------------------------------------------------------------------------------------------
  route.get('/installations/{id}/overrides', ({ params }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    return HttpResponse.json(
      {
        doc: row.overrides,
        updatedAt: row.updatedAt,
        userOverrides: entryOf(row)?.userOverrides ?? ('full' as const),
        rejected: [],
      },
      { headers: etagHeaders(row.updatedAt) },
    );
  }),

  route.put('/installations/{id}/overrides', async ({ params, body }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const doc = await body();
    const errors = documentErrors(doc);
    if (errors.length) {
      return problem(
        400,
        'validation_failed',
        'The overrides document is invalid',
        undefined,
        errors,
      );
    }
    row.overrides = doc;
    row.updatedAt = nowIso();
    return HttpResponse.json(
      {
        doc,
        updatedAt: row.updatedAt,
        userOverrides: entryOf(row)?.userOverrides ?? ('full' as const),
        rejected: [],
      },
      { headers: etagHeaders(row.updatedAt) },
    );
  }),

  route.post('/overrides/preview', async ({ body }) => {
    const input = await body();
    const errors = documentErrors(input.doc);
    if (errors.length) {
      return problem(
        400,
        'validation_failed',
        'The overrides document is invalid',
        undefined,
        errors,
      );
    }
    if (input.installationId === undefined && input.upstream === undefined) {
      return validation([{ path: '/', message: 'give installationId or upstream' }]);
    }
    const row = input.installationId ? visibleInstallation(input.installationId) : undefined;
    if (input.installationId && !row) return notFound('Installation');
    const upstream = row
      ? (data().upstream[row.id] ?? toUpstream([]))
      : {
          tools: input.upstream?.tools ?? [],
          prompts: input.upstream?.prompts ?? [],
          resources: input.upstream?.resources ?? [],
          resourceTemplates: input.upstream?.resourceTemplates ?? [],
        };
    return HttpResponse.json(
      previewFor(
        upstream as Upstream,
        row ? versionOfInstallation(row)?.overrides : undefined,
        input.doc,
      ),
    );
  }),

  // --- endpoints (7.1) -----------------------------------------------------------------------------------------------
  route.get('/endpoints', ({ url }) => HttpResponse.json(pageOf(data().endpoints, url))),

  route.post('/endpoints', async ({ body }) => {
    const input = await body();
    const errors = endpointErrors(input);
    if (errors.length) return validation(errors);
    if (data().endpoints.some((e) => e.slug === input.slug)) {
      return problem(409, 'slug_collision', 'You already have an endpoint with this slug');
    }
    const row: Endpoint = {
      id: nextId('e'),
      ownerType: 'user',
      ownerId: ME,
      slug: input.slug,
      displayName: input.displayName,
      installationIds: input.installationIds ?? [],
      prefixMode: input.prefixMode ?? 'always',
      instructions: input.instructions ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data().endpoints.push(row);
    return HttpResponse.json(row, { status: 201, headers: etagHeaders(row.updatedAt) });
  }),

  route.get('/endpoints/{id}', ({ params }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    return row
      ? HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) })
      : notFound('Endpoint');
  }),

  route.patch('/endpoints/{id}', async ({ params, request, body }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    if (!row) return notFound('Endpoint');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    const patch = await body();
    if (Object.keys(patch).length === 0) {
      return validation([{ path: '/', message: 'at least one field is required' }]);
    }
    const errors = endpointErrors(patch, true);
    if (errors.length) return validation(errors);
    if (patch.slug && data().endpoints.some((e) => e.id !== row.id && e.slug === patch.slug)) {
      return problem(409, 'slug_collision', 'You already have an endpoint with this slug');
    }
    Object.assign(row, patch, { updatedAt: nowIso() });
    return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
  }),

  route.delete('/endpoints/{id}', ({ params, request }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    if (!row) return notFound('Endpoint');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    data().endpoints = data().endpoints.filter((e) => e.id !== row.id);
    return noContent();
  }),

  route.get('/endpoints/{id}/client-config', ({ params, url }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    if (!row) return notFound('Endpoint');
    const q = clientQuery(url);
    if (!q) return validation([{ path: '/client', message: 'Invalid option' }]);
    return HttpResponse.json(
      clientConfig(
        q.client,
        `${getDb().me.org.baseUrl}/mcp/e/${row.slug}`,
        `bastion-${row.slug}`,
        q.auth,
      ),
    );
  }),

  route.get('/client-config', ({ url }) => {
    const q = clientQuery(url);
    if (!q) return validation([{ path: '/client', message: 'Invalid option' }]);
    return HttpResponse.json(
      clientConfig(q.client, `${getDb().me.org.baseUrl}/mcp`, 'bastion-default', q.auth),
    );
  }),

  // --- the store (11.1) ----------------------------------------------------------------------------------------------
  route.get('/store', ({ url }) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const kind = url.searchParams.get('kind');
    const rows = catalog()
      .entries.filter(visibleInStore)
      .filter((e) => (kind ? e.kind === kind : true))
      .filter((e) =>
        q ? `${e.slug} ${e.displayName} ${e.description}`.toLowerCase().includes(q) : true,
      )
      .map(storeRow);
    return HttpResponse.json(pageOf(rows, url));
  }),

  route.get('/store/{slug}', ({ params }) => {
    const entry = catalog().entries.find((e) => e.slug === params.slug && visibleInStore(e));
    if (!entry) return notFound('Entry');
    const current = catalog().versions.find((v) => v.id === entry.currentVersionId);
    return HttpResponse.json({
      ...storeRow(entry),
      version: current
        ? {
            id: current.id,
            label: current.label,
            changelog: current.changelog,
            installForm: current.installForm,
            publishedAt: current.publishedAt,
          }
        : null,
    });
  }),
];

const endpointErrors = (
  input: {
    slug?: string | undefined;
    displayName?: string | undefined;
    installationIds?: string[] | undefined;
  },
  partial = false,
) => {
  const errors: { path: string; message: string }[] = [];
  if (!partial || input.slug !== undefined) {
    if (!input.slug || input.slug.length < 2 || input.slug.length > 40) {
      errors.push({ path: '/slug', message: 'Too small: expected string to have >=2 characters' });
    } else if (!isValidSlug(input.slug)) {
      errors.push({ path: '/slug', message: 'use lowercase letters, digits and dashes' });
    }
  }
  if ((!partial || input.displayName !== undefined) && !input.displayName?.trim()) {
    errors.push({
      path: '/displayName',
      message: 'Too small: expected string to have >=1 characters',
    });
  }
  for (const id of input.installationIds ?? []) {
    if (!visibleInstallation(id)) {
      errors.push({ path: '/installationIds', message: `unknown installation ${id}` });
    }
  }
  return errors;
};

// --- samples ------------------------------------------------------------------------------------------------------

/** One valid call per route (route-contract.test.ts checks the bodies and responses against the OpenAPI schemas). */
export const serversSamples: SampleFactory = (db) => {
  const s = db.data.servers;
  const inst = s.installations.find((i) => i.id === 'i-jira');
  const sandboxed = s.installations.find((i) => i.id === 'i-postgres');
  const endpoint = s.endpoints[0];
  const entry = db.data.catalog.entries.find((e) => e.slug === 'servicedesk');
  const samples: Sample[] = [
    { method: 'get', path: '/installations' },
    { method: 'get', path: '/store' },
    { method: 'get', path: '/endpoints' },
    { method: 'get', path: '/client-config?client=claude-code' },
    { method: 'get', path: '/store/jira' },
    {
      method: 'post',
      path: '/installations',
      body: {
        catalogEntryId: entry?.id ?? 'c-servicedesk',
        ownerType: 'user',
        slug: 'servicedesk',
        variables: {},
        pinnedVersion: false,
      },
    },
    {
      method: 'post',
      path: '/endpoints',
      body: {
        slug: 'ops',
        displayName: 'Ops',
        installationIds: ['i-jira'],
        prefixMode: 'onCollision',
        instructions: 'Use for operations work.',
      },
    },
  ];
  if (inst) {
    const base = `/installations/${inst.id}`;
    samples.push(
      { method: 'get', path: base },
      { method: 'get', path: `${base}/tools` },
      { method: 'get', path: `${base}/prompts` },
      { method: 'get', path: `${base}/resources` },
      { method: 'get', path: `${base}/templates` },
      { method: 'get', path: `${base}/egress` },
      { method: 'get', path: `${base}/overrides` },
      {
        method: 'put',
        path: `${base}/overrides`,
        body: { version: 1, tools: { search_issues: { title: 'Find issues' } } },
      },
      {
        method: 'post',
        path: `${base}/try`,
        body: { kind: 'tool', name: 'search_issues', arguments: { query: 'bug' } },
      },
      {
        method: 'patch',
        path: base,
        body: { displayName: 'Jira (work)', toolPrefix: 'jira_work', enabled: true },
      },
      { method: 'post', path: `${base}/restart` },
      { method: 'post', path: `${base}/connect`, body: { returnTo: `/servers/${inst.id}` } },
      { method: 'put', path: `${base}/secrets/API_KEY`, body: { value: 'secret' } },
      { method: 'delete', path: `${base}/connection` },
      {
        method: 'post',
        path: '/overrides/preview',
        body: {
          doc: { version: 1, tools: { get_issue: { description: 'Read an issue' } } },
          layer: 'installation',
          installationId: inst.id,
        },
      },
    );
  }
  if (sandboxed) {
    samples.push(
      { method: 'get', path: `/installations/${sandboxed.id}/egress` },
      { method: 'delete', path: `/installations/${sandboxed.id}` },
    );
  }
  if (endpoint) {
    samples.push(
      { method: 'get', path: `/endpoints/${endpoint.id}` },
      {
        method: 'patch',
        path: `/endpoints/${endpoint.id}`,
        body: { displayName: 'Engineering tools', prefixMode: 'onCollision', instructions: null },
      },
      { method: 'delete', path: `/endpoints/${endpoint.id}` },
      { method: 'get', path: `/endpoints/${endpoint.id}/client-config?client=cursor` },
    );
  }
  return samples;
};
