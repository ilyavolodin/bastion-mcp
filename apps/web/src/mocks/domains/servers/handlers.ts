/** Installations: sign-in, secrets, what a server serves, try-it, overrides. `serversHandlers` is the whole domain. */
import { isValidSlug, slugify, toolPrefixFromSlug } from '@bastion-mcp/core/ids';
import { sse } from 'msw';
import type { Body, Res } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  forbidden,
  HttpResponse,
  noContent,
  notFound,
  P,
  pageOf,
  problem,
  route,
} from '../../http';
import { managesTeam } from '../../roles';
import { ME_ID } from '../../seed';
import { ITEMS } from '../../servers/definitions';
import {
  definitionsFor,
  documentErrors,
  previewFor,
  toUpstream,
  type Upstream,
} from '../../servers/overrides-engine';
import { getDb, nextId } from '../../state';
import { nowIso } from '../../util';
import { endpointHandlers } from './endpoints';
import {
  authModeOf,
  canManage,
  catalog,
  data,
  entryOf,
  layersOf,
  validation,
  versionOfInstallation,
  visibleInstallation,
} from './store';
import { storefrontHandlers } from './storefront';
import type { Installation } from './types';

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
    if (team && !managesTeam(input.teamId ?? '')) {
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
    const ownerId = team ? (input.teamId ?? '') : ME_ID;
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

  route.delete('/installations/{id}/connection', ({ request, params }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    row.status = row.enabled ? 'reconnect_required' : 'disabled';
    row.updatedAt = nowIso();
    return noContent();
  }),

  route.put('/installations/{id}/secrets/{name}', async ({ request, params, body }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const stale = checkVersion(request, row);
    if (stale) return stale;
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
    const upstream = data().upstream[row.id] ?? toUpstream([]);
    const failed = (text: string, ms = 3) =>
      HttpResponse.json<Res<'post', '/installations/{id}/try'>>({
        result: { content: [{ type: 'text', text }], isError: true },
        isError: true,
        durationMs: ms,
        callId: null,
      });
    if (input.kind === 'prompt') {
      const prompts = definitionsFor('prompt', upstream, layersOf(row), null).items;
      const prompt = prompts.find((p) => p.name === input.name);
      if (!prompt) return failed(`Unknown prompt: ${input.name}`);
      const given = Object.entries(input.arguments ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      return HttpResponse.json({
        result: {
          description: prompt.description,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Summarize the numbers (${given || 'no arguments'}).`,
              },
            },
          ],
        },
        isError: false,
        durationMs: 31,
        callId: nextId('call'),
      });
    }
    if (input.kind === 'resource') {
      const resources = definitionsFor('resource', upstream, layersOf(row), null).items;
      const templates = definitionsFor('resourceTemplate', upstream, layersOf(row), null).items;
      const known =
        resources.some((r) => r.uri === input.uri) ||
        templates.some((t) => {
          const pattern = String(t.uriTemplate ?? '').replace(/\{[^}]+\}/g, '[^/]+');
          return new RegExp(`^${pattern}$`).test(input.uri);
        });
      if (!known) return failed(`Resource not found: ${input.uri}`);
      return HttpResponse.json({
        result: {
          contents: [{ uri: input.uri, mimeType: 'text/plain', text: `contents of ${input.uri}` }],
        },
        isError: false,
        durationMs: 18,
        callId: nextId('call'),
      });
    }
    const tools = definitionsFor('tool', upstream, layersOf(row), null).items;
    if (!tools.some((t) => t.name === input.name)) return failed(`Unknown tool: ${input.name}`);
    const rows = [
      { id: 1, orders: 482, region: 'emea' },
      { id: 2, orders: 311, region: 'apac' },
    ];
    return HttpResponse.json({
      result: {
        content: [{ type: 'text', text: `${rows.length} rows` }],
        structuredContent: { rows, rowCount: rows.length, arguments: input.arguments ?? {} },
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
      send(`${nowIso().slice(11, 19)} ${lines[++i % lines.length]}`);
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

  route.put('/installations/{id}/overrides', async ({ request, params, body }) => {
    const row = visibleInstallation(params.id);
    if (!row) return notFound('Installation');
    const stale = checkVersion(request, row);
    if (stale) return stale;
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

  ...endpointHandlers,
  ...storefrontHandlers,
];
