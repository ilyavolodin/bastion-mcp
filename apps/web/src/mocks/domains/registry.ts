/**
 * MSW mock of the registry routes (sources, browsing, install, install requests), typed by the generated OpenAPI
 * types (see `../http.ts`). Rows are in the shape of the API; `buildRegistryData` seeds the Acme registries and
 * `registryHandlers` answer from `getDb().data.registry`.
 */
import type { HttpHandler } from 'msw';
import type { Body, Schemas } from '@/api/schema';
import {
  etagHeaders,
  forbidden,
  HttpResponse,
  notFound,
  pageOf,
  problem,
  route,
  type Sample,
  type SampleFactory,
} from '../http';
import { getDb, nextId } from '../state';

type Source = Schemas['RegistrySource'];
type Server = Schemas['RegistryServer'];
type Request = Schemas['InstallRequest'];

/** What the source policy decides for the caller (`install.decision` of the detail route). */
export type Decision = 'allowed-direct' | 'needs-request' | 'denied';

export type ServerRecord = {
  summary: Server;
  serverJson: Record<string, unknown>;
  decision: Decision;
  reasons: string[];
};

export type RegistryData = {
  sources: Source[];
  servers: ServerRecord[];
  requests: Request[];
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const REASON: Record<Decision, string[]> = {
  'allowed-direct': ['The source policy lets you install this runtime directly.'],
  'needs-request': ['The source policy asks for approval before this installs.'],
  denied: ['The namespace is on the blocked list of this source.'],
};

const server = (
  now: number,
  sourceId: string,
  name: string,
  version: string,
  description: string,
  runtimes: string[],
  decision: Decision,
): ServerRecord => ({
  summary: {
    sourceId,
    name,
    version,
    status: 'active',
    isLatest: true,
    title: name.split('/').pop() ?? name,
    description,
    publishedAt: iso(now - 20 * DAY),
    runtimes,
  },
  serverJson: { name, version, description },
  decision,
  reasons: REASON[decision],
});

export const buildRegistryData = (now: number): RegistryData => ({
  sources: [
    {
      id: 'rs-official',
      name: 'Official MCP Registry',
      baseUrl: 'https://registry.modelcontextprotocol.io',
      authSecretId: null,
      authHeaderName: null,
      trust: 'official',
      enabled: true,
      syncIntervalS: 3600,
      lastUpdatedSince: iso(now - 3 * HOUR),
      lastSync: null,
      createdAt: iso(now - 90 * DAY),
      updatedAt: iso(now - 3 * HOUR),
    },
    {
      id: 'rs-acme',
      name: 'Acme internal registry',
      baseUrl: 'https://registry.acme.dev',
      authSecretId: null,
      authHeaderName: null,
      trust: 'internal',
      enabled: true,
      syncIntervalS: 3600,
      lastUpdatedSince: iso(now - 5 * HOUR),
      lastSync: null,
      createdAt: iso(now - 60 * DAY),
      updatedAt: iso(now - 5 * HOUR),
    },
  ],
  servers: [
    server(
      now,
      'rs-official',
      'io.github.modelcontextprotocol/server-everything',
      '2026.3.1',
      'Reference server that exercises every MCP feature',
      ['npm'],
      'allowed-direct',
    ),
    server(
      now,
      'rs-official',
      'io.github.stripe/mcp',
      '1.5.0',
      'Payments, customers and invoices',
      ['remote'],
      'needs-request',
    ),
    server(
      now,
      'rs-official',
      'com.figma/mcp',
      '0.9.2',
      'Read designs and components',
      ['remote'],
      'allowed-direct',
    ),
    server(
      now,
      'rs-official',
      'com.cloudflare/mcp',
      '2.1.0',
      'Workers, DNS and analytics',
      ['remote'],
      'needs-request',
    ),
    server(
      now,
      'rs-official',
      'io.github.unknown/crypto-miner',
      '0.0.1',
      'Unreviewed community server',
      ['npm'],
      'denied',
    ),
    server(
      now,
      'rs-acme',
      'dev.acme/ledger',
      '1.2.0',
      'General ledger queries',
      ['pypi'],
      'allowed-direct',
    ),
    server(
      now,
      'rs-acme',
      'dev.acme/hr-lookup',
      '0.4.0',
      'Org chart and on-call lookup',
      ['remote'],
      'needs-request',
    ),
  ],
  requests: [
    request(
      'rq-1',
      'u-raj',
      'rs-official',
      'com.cloudflare/mcp',
      '2.1.0',
      'Debug edge cache rules',
      iso(now - 5 * HOUR),
    ),
    request(
      'rq-2',
      'u-jo',
      'rs-official',
      'io.github.stripe/mcp',
      '1.5.0',
      'Revenue questions',
      iso(now - DAY),
    ),
    request(
      'rq-3',
      'u-ana',
      'rs-acme',
      'dev.acme/hr-lookup',
      '0.4.0',
      'Find the on-call',
      iso(now - 2 * DAY),
    ),
  ],
});

function request(
  id: string,
  requesterId: string,
  sourceId: string,
  serverName: string,
  version: string,
  justification: string,
  at: string,
): Request {
  return {
    id,
    requesterId,
    sourceId,
    serverName,
    version,
    justification,
    status: 'open',
    decidedBy: null,
    decidedAt: null,
    reason: null,
    createdAt: at,
    updatedAt: at,
  };
}

// --- handlers -----------------------------------------------------------------------------------------------------

const data = () => getDb().data.registry;
const nowIso = () => new Date().toISOString();
const POLICY_STORED_AT = '2026-09-20T09:00:00.000Z';
const canDecide = () => getDb().role === 'admin' || getDb().role === 'manager';
/** The registry is hidden from auditors (`capabilities.registry`). */
const hasRegistry = () => getDb().role !== 'auditor';

const invalid = (errors: { path: string; message: string }[]) =>
  problem(
    422,
    'validation_failed',
    'Some fields need attention',
    'The request is not valid.',
    errors,
  );

const find = (sourceId: string, name: string, version: string) =>
  data().servers.find(
    (s) =>
      s.summary.sourceId === sourceId && s.summary.name === name && s.summary.version === version,
  );

export const registryHandlers: HttpHandler[] = [
  route.get('/registry-sources', ({ url }) => HttpResponse.json(pageOf(data().sources, url))),

  route.post('/registry-sources', async ({ body }) => {
    const input = await body();
    const at = nowIso();
    const created: Source = {
      id: nextId('rs'),
      name: input.name,
      baseUrl: input.baseUrl,
      authSecretId: input.authSecretId ?? null,
      authHeaderName: input.authHeaderName ?? null,
      trust: input.trust ?? 'community',
      enabled: input.enabled ?? true,
      syncIntervalS: input.syncIntervalS ?? 3600,
      lastUpdatedSince: null,
      lastSync: null,
      createdAt: at,
      updatedAt: at,
    };
    data().sources.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),
  route.patch('/registry-sources/{id}', async ({ params, body }) => {
    const source = data().sources.find((x) => x.id === params.id);
    if (!source) return notFound('Registry source');
    Object.assign(source, await body(), { updatedAt: nowIso() });
    return HttpResponse.json(source);
  }),
  route.delete('/registry-sources/{id}', ({ params }) => {
    const i = data().sources.findIndex((x) => x.id === params.id);
    if (i < 0) return notFound('Registry source');
    data().sources.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  route.post('/registry-sources/{id}/sync', ({ params }) => {
    const source = data().sources.find((x) => x.id === params.id);
    if (!source) return notFound('Registry source');
    if (!source.enabled) {
      return problem(409, 'source_disabled', 'Conflict', 'this registry source is disabled');
    }
    const at = nowIso();
    const stats = {
      startedAt: at,
      finishedAt: at,
      ok: true,
      full: false,
      pages: 1,
      fetched: data().servers.length,
      upserted: data().servers.length,
      invalid: 0,
      deleted: 0,
      deprecated: 0,
    };
    source.lastSync = stats;
    return HttpResponse.json({ ok: true, stats, deletedNames: [], deprecatedNames: [] });
  }),
  // A stored policy: its `updatedAt` is its version, sent as the ETag (17.1). A source without one has `updatedAt: null`
  // and takes a first PUT without `If-Match`; the mock models the stored case.
  route.get('/registry-sources/{id}/policy', ({ params }) =>
    HttpResponse.json(
      {
        sourceId: params.id,
        policy: {
          allowedNamespaces: ['*'],
          blockedNamespaces: [],
          allowedRuntimes: ['remote'],
          whoMayInstall: 'managers',
          mode: 'request',
          requireOsvClean: true,
          maxRisk: 'low',
        },
        updatedAt: POLICY_STORED_AT,
      },
      { headers: etagHeaders(POLICY_STORED_AT) },
    ),
  ),
  route.put('/registry-sources/{id}/policy', async ({ params, body }) => {
    const updatedAt = nowIso();
    return HttpResponse.json(
      { sourceId: params.id, policy: (await body()) as never, updatedAt },
      { headers: etagHeaders(updatedAt) },
    );
  }),

  route.get('/registry/servers', ({ url }) => {
    if (!hasRegistry()) return forbidden();
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const sourceId = url.searchParams.get('sourceId');
    const items = data()
      .servers.map((s) => s.summary)
      .filter(
        (s) =>
          (!sourceId || s.sourceId === sourceId) &&
          (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)),
      );
    const enabled = new Set(
      data()
        .sources.filter((x) => x.enabled)
        .map((x) => x.id),
    );
    return HttpResponse.json(
      pageOf(
        items
          .filter((x) => enabled.has(x.sourceId))
          .map((x) => {
            const src = data().sources.find((y) => y.id === x.sourceId);
            return {
              ...x,
              sourceName: src?.name ?? '',
              trust: src?.trust as 'official',
              sourceEnabled: true,
            };
          }),
        url,
      ),
    );
  }),
  route.get('/registry/servers/{sourceId}/{name}/{version}', ({ params }) => {
    if (!hasRegistry()) return forbidden();
    const found = find(params.sourceId, decodeURIComponent(params.name), params.version);
    if (!found) return notFound('Registry server');
    return HttpResponse.json({
      ...found.summary,
      serverJson: found.serverJson,
      install: { installable: true, decision: found.decision, reasons: found.reasons },
    });
  }),
  route.post('/registry/install', async ({ body }) => {
    if (!hasRegistry()) return forbidden();
    const input = await body();
    const found = find(input.sourceId, input.name, input.version);
    if (!found) return notFound('Registry server');
    if (found.decision === 'denied') {
      return problem(403, 'forbidden', 'Forbidden', found.reasons.join('; '));
    }
    if (found.decision === 'needs-request') {
      return HttpResponse.json(
        { decision: 'needs-request' as const, reasons: found.reasons },
        { status: 202 },
      );
    }
    return HttpResponse.json(
      {
        decision: 'installed' as const,
        reasons: found.reasons,
        entryId: nextId('c'),
        installationId: nextId('i'),
      },
      { status: 201 },
    );
  }),

  route.get('/install-requests', ({ url }) => {
    if (!hasRegistry()) return forbidden();
    const status = url.searchParams.get('status');
    const db = getDb();
    const items = data()
      .requests.filter((r) => !status || r.status === status)
      .filter((r) => canDecide() || r.requesterId === db.me.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json(pageOf(items, url));
  }),
  route.post('/install-requests', async ({ body }) => {
    if (!hasRegistry()) return forbidden();
    const input = await body();
    const errors: { path: string; message: string }[] = [];
    if (!input.justification?.trim()) errors.push({ path: '/justification', message: 'required' });
    if ((input.justification ?? '').length > 2000) {
      errors.push({ path: '/justification', message: 'at most 2000 characters' });
    }
    if (errors.length > 0) return invalid(errors);
    if (!find(input.sourceId, input.name, input.version)) return notFound('Registry server');
    const db = getDb();
    if (
      data().requests.some(
        (r) =>
          r.status === 'open' &&
          r.requesterId === db.me.id &&
          r.sourceId === input.sourceId &&
          r.serverName === input.name &&
          r.version === input.version,
      )
    ) {
      return problem(409, 'conflict', 'Conflict', 'you already asked for this server');
    }
    const at = nowIso();
    const created: Request = {
      id: nextId('rq'),
      requesterId: db.me.id,
      sourceId: input.sourceId,
      serverName: input.name,
      version: input.version,
      justification: input.justification.trim(),
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      reason: null,
      createdAt: at,
      updatedAt: at,
    };
    data().requests.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),
  route.post('/install-requests/{id}/approve', ({ params }) => {
    if (!canDecide()) return forbidden();
    const r = data().requests.find((x) => x.id === params.id);
    if (!r) return notFound('Install request');
    if (r.status !== 'open') return problem(409, 'conflict', 'Conflict', 'the request is decided');
    Object.assign(r, {
      status: 'approved' as const,
      decidedBy: getDb().me.id,
      decidedAt: nowIso(),
      updatedAt: nowIso(),
    });
    return HttpResponse.json(r);
  }),
  route.post('/install-requests/{id}/reject', async ({ params, body }) => {
    if (!canDecide()) return forbidden();
    const input = await body();
    if (!input.reason?.trim()) return invalid([{ path: '/reason', message: 'required' }]);
    const r = data().requests.find((x) => x.id === params.id);
    if (!r) return notFound('Install request');
    if (r.status !== 'open') return problem(409, 'conflict', 'Conflict', 'the request is decided');
    Object.assign(r, {
      status: 'rejected' as const,
      decidedBy: getDb().me.id,
      decidedAt: nowIso(),
      reason: input.reason.trim(),
      updatedAt: nowIso(),
    });
    return HttpResponse.json(r);
  }),
];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const registrySamples: SampleFactory = (db) => {
  const [allowed] = db.data.registry.servers.filter((s) => s.decision === 'allowed-direct');
  const [ask] = db.data.registry.servers.filter((s) => s.decision === 'needs-request');
  const key = (s: ServerRecord | undefined) =>
    `${s?.summary.sourceId}/${encodeURIComponent(s?.summary.name ?? '')}/${s?.summary.version}`;
  const samples: Sample[] = [
    { method: 'get', path: '/registry-sources' },
    { method: 'get', path: '/registry/servers' },
    {
      method: 'post',
      path: '/registry-sources',
      body: { name: 'Sample', baseUrl: 'https://sample.example.com' },
    },
    { method: 'patch', path: '/registry-sources/rs-acme', body: { enabled: true } },
    { method: 'post', path: '/registry-sources/rs-official/sync', body: { full: false } },
    { method: 'get', path: '/registry-sources/rs-official/policy' },
    {
      method: 'put',
      path: '/registry-sources/rs-official/policy',
      body: {
        allowedNamespaces: ['*'],
        blockedNamespaces: [],
        allowedRuntimes: ['remote'],
        whoMayInstall: 'managers',
        mode: 'request',
        requireOsvClean: true,
        maxRisk: 'low',
      },
    },
    { method: 'delete', path: '/registry-sources/rs-acme' },
    { method: 'get', path: `/registry/servers/${key(ask)}` },
    {
      method: 'post',
      path: '/registry/install',
      body: {
        sourceId: allowed?.summary.sourceId ?? '',
        name: allowed?.summary.name ?? '',
        version: allowed?.summary.version ?? '',
      } satisfies Body<'post', '/registry/install'>,
    },
    { method: 'get', path: '/install-requests' },
    {
      method: 'post',
      path: '/install-requests',
      body: {
        sourceId: ask?.summary.sourceId ?? '',
        name: ask?.summary.name ?? '',
        version: ask?.summary.version ?? '',
        justification: 'Needed for the quarterly review',
      } satisfies Body<'post', '/install-requests'>,
    },
    { method: 'post', path: '/install-requests/rq-1/approve' },
    {
      method: 'post',
      path: '/install-requests/rq-2/reject',
      body: { reason: 'Use Linear instead' } satisfies Body<
        'post',
        '/install-requests/{id}/reject'
      >,
    },
  ];
  return samples;
};
