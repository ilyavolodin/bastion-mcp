import { delay, HttpResponse, http, sse } from 'msw';
import type {
  AutoInstallInput,
  CallFilters,
  CatalogDraftInput,
  CatalogEntry,
  CatalogVersion,
  ClientConfig,
  ClientId,
  Installation,
  InstallationInput,
  OverrideDocument,
  PolicyRuleInput,
  SimulationInput,
  UiRole,
} from '@/api/types';
import { getDb, type MockDb, nextId, setRole } from './db';
import * as fx from './fixtures';
import { applyToCapability, previewDefinitions } from './overrides';

const P = (path: string) => `*/api/v1${path}`;
const latency = () => (import.meta.env.MODE === 'test' ? Promise.resolve() : delay(90));

export const problem = (
  status: number,
  code: string,
  title: string,
  detail?: string,
  errors?: { path: string; message: string }[],
) =>
  HttpResponse.json(
    {
      type: `https://bastion-mcp.github.io/errors/${code}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
      ...(errors ? { errors } : {}),
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

const forbidden = () =>
  problem(403, 'forbidden', 'You do not have access to this', 'Ask an admin to change your role.');
const notFound = (what = 'Resource') => problem(404, 'not_found', `${what} not found`);

const paginate = <T>(items: T[], url: URL) => {
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50);
  const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return HttpResponse.json({ items: slice, nextCursor: next } as never);
};

const roleIs = (db: MockDb, ...roles: UiRole[]) => roles.includes(db.role);
const q = (url: URL, name: string) => url.searchParams.get(name) ?? '';
const etagged = (body: object, version: string) =>
  HttpResponse.json(body as never, { headers: { ETag: `"${version}"` } });

const filePath = (url: string) =>
  decodeURIComponent(new URL(url).pathname.replace(/^.*\/files\//, ''));

const entrySlug = (inst: Installation) => (inst.catalogEntryId ?? '').replace(/^c-/, '');

const buildClientConfig = (client: ClientId, url: string): ClientConfig => {
  switch (client) {
    case 'claude-desktop':
      return {
        client,
        label: 'Claude Desktop',
        format: 'json',
        filename: 'claude_desktop_config.json',
        content: JSON.stringify(
          { mcpServers: { bastion: { command: 'npx', args: ['-y', 'mcp-remote', url] } } },
          null,
          2,
        ),
        instructions: 'Paste into Settings, Developer, Edit config, then restart Claude Desktop.',
      };
    case 'claude-code':
      return {
        client,
        label: 'Claude Code',
        format: 'command',
        filename: null,
        content: `claude mcp add --transport http bastion ${url}`,
        instructions: 'Run this once in a terminal, then sign in from /mcp.',
      };
    case 'cursor':
      return {
        client,
        label: 'Cursor',
        format: 'json',
        filename: '~/.cursor/mcp.json',
        content: JSON.stringify({ mcpServers: { bastion: { url } } }, null, 2),
        instructions: 'Save as ~/.cursor/mcp.json and reload Cursor.',
      };
    case 'vscode':
      return {
        client,
        label: 'VS Code',
        format: 'json',
        filename: '.vscode/mcp.json',
        content: JSON.stringify({ servers: { bastion: { type: 'http', url } } }, null, 2),
        instructions: 'Save as .vscode/mcp.json in your workspace.',
      };
  }
};

const callsFor = (db: MockDb, url: URL) => {
  const rangeMs =
    { '1h': fx.HOUR, '24h': fx.DAY, '7d': 7 * fx.DAY }[q(url, 'range') || '24h'] ?? fx.DAY;
  const outcome = q(url, 'outcome');
  const f: CallFilters = {
    userId: q(url, 'userId'),
    teamId: q(url, 'teamId'),
    installationId: q(url, 'installationId'),
    item: q(url, 'item'),
  };
  return db.calls.filter((c) => {
    if (db.role === 'member' && c.principalId !== db.me.id) return false;
    if (new Date(c.startedAt).getTime() < db.now - rangeMs) return false;
    if (outcome && c.outcome !== outcome) return false;
    if (f.userId && c.principalId !== f.userId) return false;
    if (f.installationId && c.installationId !== f.installationId) return false;
    if (f.teamId) {
      const team = db.teams.find((t) => t.id === f.teamId);
      if (!team || c.teamName !== team.name) return false;
    }
    if (f.item && !c.item.toLowerCase().includes(f.item.toLowerCase())) return false;
    return true;
  });
};

// The typed SSE client only knows the default 'message' event; named events are sent as-is.
type SseClient = { send: (m: never) => void };
const SSE_CLIENTS = new Set<SseClient>();
const sendNamed = (c: SseClient, event: string, data: string) =>
  (c.send as (m: { event: string; data: string }) => void)({ event, data });
/** Pushes a server event to every open `/events` stream (demo and tests). */
export const emitMockEvent = (event: string, data: unknown): void => {
  if (event === 'notification')
    getDb().notifications.unshift(data as MockDb['notifications'][number]);
  for (const c of [...SSE_CLIENTS]) {
    try {
      sendNamed(c, event, JSON.stringify(data));
    } catch {
      SSE_CLIENTS.delete(c);
    }
  }
};

export const handlers = [
  // CSRF double-submit on every state-changing call (9.2).
  http.all(P('/*'), ({ request }) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !request.headers.get('x-bastion-csrf')
    ) {
      return problem(403, 'csrf_missing', 'Missing CSRF token', 'Reload the page and try again.');
    }
    return undefined;
  }),

  // --- Session ---------------------------------------------------------------------------------------
  http.get(P('/me'), async () => {
    await latency();
    const stored =
      typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('bastion.mockRole');
    if (stored === 'admin' || stored === 'manager' || stored === 'member' || stored === 'auditor')
      setRole(stored);
    return HttpResponse.json(getDb().me);
  }),
  http.patch(P('/me'), async ({ request }) => {
    const body = (await request.json()) as { theme?: 'light' | 'dark' };
    const db = getDb();
    if (body.theme) db.me.theme = body.theme;
    return HttpResponse.json(db.me);
  }),
  http.get(P('/me/notifications'), ({ request }) =>
    paginate(getDb().notifications, new URL(request.url)),
  ),
  http.post(P('/me/notifications/:id/read'), ({ params }) => {
    const n = getDb().notifications.find((x) => x.id === params.id);
    if (n) n.readAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/me/quotas'), () =>
    HttpResponse.json({
      items: [
        { id: 'q-calls', name: 'Tool calls', used: 1240, limit: 5000, mode: 'left' },
        { id: 'q-sandbox', name: 'Sandbox minutes', used: 144, limit: 240, mode: 'left' },
        { id: 'q-conc', name: 'Concurrent calls', used: 2, limit: 8, mode: 'inUse' },
      ],
    }),
  ),

  // --- Installations ---------------------------------------------------------------------------------
  http.get(P('/installations'), async ({ request }) => {
    await latency();
    const db = getDb();
    return paginate(
      db.installations.map((i) => ({
        ...i,
        canManage: roleIs(db, 'admin', 'manager') || i.ownerType === 'user',
      })),
      new URL(request.url),
    );
  }),
  http.post(P('/installations'), async ({ request }) => {
    const db = getDb();
    const input = (await request.json()) as InstallationInput;
    const entry = fx.buildStoreEntry(input.entrySlug, new Set());
    if (!entry) return notFound('Catalog entry');
    const missing = entry.form.variables
      .filter((v) => v.required && !input.variables[v.name])
      .map((v) => ({ path: `variables.${v.name}`, message: `${v.label} is required` }));
    if (missing.length)
      return problem(422, 'validation_failed', 'Some fields need attention', undefined, missing);
    const exists = db.installations.some((i) => i.slug === input.entrySlug);
    const base = db.installations.find((i) => i.slug === input.entrySlug);
    if (exists && base) return HttpResponse.json(base, { status: 200 });
    const inst: Installation = {
      id: nextId('i'),
      slug: entry.slug,
      toolPrefix: entry.slug.replace(/-/g, '_'),
      displayName: entry.displayName,
      letter: entry.letter,
      color: entry.color,
      catalogEntryId: entry.id,
      versionLabel: entry.version,
      package: null,
      runtime: entry.runtime,
      authMode: entry.authMode,
      isolation: entry.isolation,
      ownerType: 'user',
      ownerName: db.me.name,
      origin: 'manual',
      enabled: true,
      hidden: false,
      pinnedVersion: false,
      status:
        entry.authMode === 'oauth' || entry.authMode === 'userSecret' ? 'needs_setup' : 'ready',
      statusDetail: null,
      canManage: true,
      spark24: [],
      endpointUrl: `https://${fx.HOST}/mcp/i/${entry.slug}`,
      toolCount: entry.items.filter((i) => i.kind === 'tool').length,
      secrets: entry.form.secrets.map((s) => ({ name: s.name, set: false })),
      oauth: entry.setup.oauthProvider
        ? {
            provider: entry.setup.oauthProvider,
            scopes: ['read'],
            connected: false,
            expiresAt: null,
          }
        : null,
      updatedAt: new Date().toISOString(),
    };
    db.installations.push(inst);
    db.egress[inst.id] = {
      hosts: entry.egressHosts.map((host) => ({
        host,
        status: 'allowed',
        reason: 'Declared by the catalog entry',
        lastSeenAt: null,
      })),
      requests: [],
    };
    return HttpResponse.json(inst, { status: 201 });
  }),
  http.get(P('/installations/:id'), ({ params }) => {
    const db = getDb();
    const inst = db.installations.find((i) => i.id === params.id);
    if (!inst) return notFound('Installation');
    return etagged(
      { ...inst, canManage: roleIs(db, 'admin', 'manager') || inst.ownerType === 'user' },
      inst.updatedAt,
    );
  }),
  http.patch(P('/installations/:id'), async ({ params, request }) => {
    const db = getDb();
    const inst = db.installations.find((i) => i.id === params.id);
    if (!inst) return notFound('Installation');
    const match = request.headers.get('if-match');
    if (match && match !== `"${inst.updatedAt}"`) {
      return problem(
        412,
        'precondition_failed',
        'Changed by someone else',
        'Reload and try again.',
      );
    }
    Object.assign(inst, await request.json(), { updatedAt: new Date().toISOString() });
    if (inst.enabled && inst.status === 'disabled') inst.status = 'ready';
    return etagged(inst, inst.updatedAt);
  }),
  http.delete(P('/installations/:id'), ({ params }) => {
    const db = getDb();
    db.installations = db.installations.filter((i) => i.id !== params.id);
    for (const e of db.endpoints)
      e.installationIds = e.installationIds.filter((x) => x !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(P('/installations/:id/restart'), () => new HttpResponse(null, { status: 204 })),
  http.post(P('/installations/:id/connect'), ({ params }) => {
    const inst = getDb().installations.find((i) => i.id === params.id);
    if (!inst) return notFound('Installation');
    // The real flow redirects to the upstream's OAuth page; the mock completes it immediately.
    inst.status = inst.secrets.every((s) => s.set) ? 'ready' : inst.status;
    if (inst.oauth) {
      inst.oauth.connected = true;
      inst.oauth.expiresAt = new Date(Date.now() + 30 * fx.DAY).toISOString();
    }
    if (inst.authMode === 'oauth') inst.status = 'ready';
    // An empty url means "already done": the SPA only opens a window when there is somewhere to go.
    return HttpResponse.json({ url: '' });
  }),
  http.delete(P('/installations/:id/connection'), ({ params }) => {
    const inst = getDb().installations.find((i) => i.id === params.id);
    if (inst?.oauth) {
      inst.oauth.connected = false;
      inst.status = 'reconnect_required';
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.put(P('/installations/:id/secrets/:name'), ({ params }) => {
    const inst = getDb().installations.find((i) => i.id === params.id);
    if (!inst) return notFound('Installation');
    const s = inst.secrets.find((x) => x.name === params.name);
    if (s) s.set = true;
    else inst.secrets.push({ name: String(params.name), set: true });
    if (inst.authMode === 'userSecret' && inst.secrets.every((x) => x.set)) inst.status = 'ready';
    return new HttpResponse(null, { status: 204 });
  }),
  ...(['tools', 'prompts', 'resources', 'templates'] as const).map((path) =>
    http.get(P(`/installations/:id/${path}`), ({ params }) => {
      const db = getDb();
      const inst = db.installations.find((i) => i.id === params.id);
      if (!inst) return notFound('Installation');
      const kind = {
        tools: 'tool',
        prompts: 'prompt',
        resources: 'resource',
        templates: 'template',
      }[path];
      const doc = db.overrides[inst.id] ?? { version: 1 as const };
      const items = (fx.ITEMS[entrySlug(inst)] ?? [])
        .filter((i) => i.kind === kind)
        .map((i) => applyToCapability(i, doc));
      return HttpResponse.json({ items, nextCursor: null });
    }),
  ),
  http.get(P('/installations/:id/egress'), ({ params }) =>
    HttpResponse.json(getDb().egress[String(params.id)] ?? { hosts: [], requests: [] }),
  ),
  http.post(P('/installations/:id/egress'), async ({ params, request }) => {
    const db = getDb();
    const body = (await request.json()) as { host: string; reason: string };
    const rec = { id: nextId('er'), host: body.host, status: 'open' as const, reason: body.reason };
    const bucket = db.egress[String(params.id)] ?? { hosts: [], requests: [] };
    bucket.requests.push(rec);
    db.egress[String(params.id)] = bucket;
    return HttpResponse.json(rec, { status: 201 });
  }),
  http.get(P('/installations/:id/overrides'), ({ params }) => {
    const db = getDb();
    return etagged(
      {
        document: db.overrides[String(params.id)] ?? { version: 1 },
        layer: 'installation',
        canEdit: roleIs(db, 'admin', 'manager', 'member'),
      },
      'ov-1',
    );
  }),
  http.put(P('/installations/:id/overrides'), async ({ params, request }) => {
    getDb().overrides[String(params.id)] = (await request.json()) as OverrideDocument;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(P('/overrides/preview'), async ({ request }) => {
    const db = getDb();
    const body = (await request.json()) as { installationId: string; document: OverrideDocument };
    const inst = db.installations.find((i) => i.id === body.installationId);
    return HttpResponse.json(
      previewDefinitions(fx.ITEMS[inst ? entrySlug(inst) : ''] ?? [], body.document),
    );
  }),
  http.post(P('/installations/:id/try'), async ({ request }) => {
    const body = (await request.json()) as { name: string; arguments: Record<string, unknown> };
    const blocked = /drop\s+table/i.test(JSON.stringify(body.arguments));
    return HttpResponse.json({
      ok: !blocked,
      isError: blocked,
      text: blocked
        ? 'Blocked by guard: SQL write pattern'
        : JSON.stringify(
            {
              tool: body.name,
              rows: [
                { id: 1, total: 42 },
                { id: 2, total: 17 },
              ],
            },
            null,
            2,
          ),
      durationMs: blocked ? 31 : 184,
      guard: blocked ? 'SQL write pattern' : null,
    });
  }),
  sse(P('/installations/:id/logs'), ({ client, request }) => {
    const lines = [
      'npx -y @acme/pg-mcp@3.2.0',
      'pg-mcp listening on stdio · protocol 2025-11-25',
      'connected to warehouse.acme.internal:5432',
      'query ok rows=214 elapsed=41ms',
      'warn: DATABASE_URL uses a read-write role; consider analytics_ro',
    ];
    let i = 0;
    sendNamed(client, 'log', lines[0] ?? '');
    const timer = setInterval(() => {
      sendNamed(
        client,
        'log',
        `${new Date().toISOString().slice(11, 19)} ${lines[++i % lines.length]}`,
      );
    }, 2500);
    request.signal.addEventListener('abort', () => clearInterval(timer));
  }),

  // --- Endpoints --------------------------------------------------------------------------------------
  http.get(P('/endpoints'), ({ request }) => paginate(getDb().endpoints, new URL(request.url))),
  http.post(P('/endpoints'), async ({ request }) => {
    const body = (await request.json()) as { name: string; installationIds: string[] };
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const db = getDb();
    const tools = db.installations
      .filter((i) => body.installationIds.includes(i.id))
      .reduce((n, i) => n + i.toolCount, 0);
    const ep = {
      id: nextId('e'),
      slug,
      name: body.name,
      url: `https://${fx.HOST}/mcp/c/${slug}`,
      isDefault: false,
      installationIds: body.installationIds,
      toolCount: tools,
      updatedAt: new Date().toISOString(),
    };
    db.endpoints.push(ep);
    return HttpResponse.json(ep, { status: 201 });
  }),
  http.patch(P('/endpoints/:id'), async ({ params, request }) => {
    const db = getDb();
    const ep = db.endpoints.find((e) => e.id === params.id);
    if (!ep) return notFound('Endpoint');
    Object.assign(ep, await request.json());
    ep.toolCount = db.installations
      .filter((i) => ep.installationIds.includes(i.id))
      .reduce((n, i) => n + i.toolCount, 0);
    return HttpResponse.json(ep);
  }),
  http.delete(P('/endpoints/:id'), ({ params }) => {
    const db = getDb();
    db.endpoints = db.endpoints.filter((e) => e.id !== params.id || e.isDefault);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/endpoints/:id/client-config'), ({ params, request }) => {
    const ep = getDb().endpoints.find((e) => e.id === params.id);
    if (!ep) return notFound('Endpoint');
    const client = (q(new URL(request.url), 'client') || 'claude-desktop') as ClientId;
    return HttpResponse.json(buildClientConfig(client, ep.url));
  }),

  // --- Store ---------------------------------------------------------------------------------------------
  http.get(P('/store'), async ({ request }) => {
    await latency();
    const db = getDb();
    const installed = new Set(db.installations.map((i) => i.slug));
    const text = q(new URL(request.url), 'q').toLowerCase();
    const entries = fx
      .storeSlugs()
      .map((s) => fx.buildStoreEntry(s, installed))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .filter((e) => {
        if (!text) return true;
        const toolText = e.items.map((i) => `${i.name} ${i.description}`).join(' ');
        return `${e.displayName} ${e.description} ${e.tags.join(' ')} ${toolText}`
          .toLowerCase()
          .includes(text);
      })
      .map(
        ({
          items: _items,
          summary: _s,
          setup: _su,
          egressHosts: _e,
          guards: _g,
          versions: _v,
          form: _f,
          canEdit: _c,
          ...card
        }) => card,
      );
    return paginate(entries, new URL(request.url));
  }),
  http.get(P('/store/:slug'), ({ params }) => {
    const db = getDb();
    const e = fx.buildStoreEntry(String(params.slug), new Set(db.installations.map((i) => i.slug)));
    if (!e) return notFound('Store entry');
    return HttpResponse.json({ ...e, canEdit: roleIs(db, 'admin', 'manager') });
  }),

  // --- Calls and stats -----------------------------------------------------------------------------------
  http.get(P('/calls'), async ({ request }) => {
    await latency();
    return paginate(callsFor(getDb(), new URL(request.url)), new URL(request.url));
  }),
  http.get(P('/calls/:id'), ({ params }) => {
    const c = getDb().calls.find((x) => x.id === params.id);
    return c ? HttpResponse.json(fx.buildCallDetail(c)) : notFound('Call');
  }),
  http.get(P('/stats/calls'), ({ request }) => {
    const url = new URL(request.url);
    const db = getDb();
    if (q(url, 'groupBy') === 'client,installation') return HttpResponse.json(fx.buildFlow());
    const range = q(url, 'range') || '24h';
    const inst = q(url, 'installationId');
    const buckets = fx.buildCallSeries(range, db.now, db.role === 'member' || inst ? 0.4 : 1);
    return HttpResponse.json({ buckets, trend: 'up' });
  }),
  http.get(P('/stats/latency'), () => HttpResponse.json({ buckets: fx.buildLatency(getDb().now) })),
  http.get(P('/stats/sandboxes'), () => HttpResponse.json(fx.buildSandboxStats(getDb().now))),
  http.get(P('/stats/guards'), () => HttpResponse.json(fx.buildGuardStats(getDb().now))),
  http.get(P('/security/findings'), ({ request }) =>
    paginate(fx.buildFindings(getDb().now), new URL(request.url)),
  ),
  http.get(P('/drift-reviews'), ({ request }) => {
    const db = getDb();
    const open = q(new URL(request.url), 'status') === 'open';
    return paginate(
      db.drift
        .filter((d) => !open || d.status === 'open')
        .map((d) => ({ ...d, canDecide: roleIs(db, 'admin', 'manager') })),
      new URL(request.url),
    );
  }),
  http.post(P('/drift-reviews/:id/:decision'), ({ params }) => {
    const db = getDb();
    if (!roleIs(db, 'admin', 'manager')) return forbidden();
    const d = db.drift.find((x) => x.id === params.id);
    if (!d) return notFound('Review');
    d.status = params.decision === 'approve' ? 'approved' : 'rejected';
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Catalog ----------------------------------------------------------------------------------------------
  http.get(P('/catalog'), ({ request }) => {
    const db = getDb();
    const url = new URL(request.url);
    if (!roleIs(db, 'admin', 'manager', 'auditor')) return forbidden();
    if (q(url, 'needsApproval')) {
      const items = db.catalog
        .filter(
          (c) =>
            c.executable &&
            (db.versions[c.id] ?? []).some((v) => v.executableApproval === 'pending'),
        )
        .map((c) => {
          const v = (db.versions[c.id] ?? []).find(
            (x) => x.executableApproval === 'pending',
          ) as CatalogVersion;
          return {
            entryId: c.id,
            versionId: v.id,
            name: `${c.displayName} ${v.label}`,
            letter: c.letter,
            color: c.color,
            author: 'Raj M',
            summary: 'adds 1 hook',
            diff: [
              '+ hooks/post-tool.sh',
              '+   curl -s $PAGER_URL -d @-',
              '  skills/triage/SKILL.md',
            ],
          };
        });
      return paginate(items, url);
    }
    const kind = q(url, 'kind');
    const text = q(url, 'q').toLowerCase();
    return paginate(
      db.catalog.filter(
        (c) => (!kind || c.kind === kind) && (!text || c.displayName.toLowerCase().includes(text)),
      ),
      url,
    );
  }),
  http.post(P('/catalog'), async ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin', 'manager')) return forbidden();
    const body = (await request.json()) as CatalogDraftInput;
    const id = nextId('c');
    const entry: CatalogEntry = {
      id,
      slug: body.slug || body.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      kind: body.kind,
      displayName: body.displayName,
      description: body.description,
      letter: body.displayName.charAt(0).toUpperCase() || '?',
      color: 'var(--sky)',
      status: 'draft',
      risk: body.risk,
      ownerTeamId: null,
      ownerTeamName: null,
      visibility: body.visibility,
      currentVersion: null,
      draftVersionId: `v-${id}-0.1.0`,
      versionCount: 1,
      autoUpgrade: body.autoUpgrade,
      source: 'manual',
      executable: false,
      updatedAt: new Date().toISOString(),
    };
    db.catalog.unshift(entry);
    db.versions[id] = [
      {
        id: `v-${id}-0.1.0`,
        entryId: id,
        label: body.spec.version || '0.1.0',
        status: 'draft',
        spec: body.spec,
        test: null,
        changelog: '',
        createdAt: new Date().toISOString(),
        executableApproval: 'none',
      },
    ];
    return HttpResponse.json({ ...entry, versions: db.versions[id] }, { status: 201 });
  }),
  http.get(P('/catalog/:id'), ({ params }) => {
    const db = getDb();
    const e = db.catalog.find((c) => c.id === params.id);
    return e
      ? HttpResponse.json({ ...e, versions: db.versions[e.id] ?? [] })
      : notFound('Catalog entry');
  }),
  http.patch(P('/catalog/:id'), async ({ params, request }) => {
    const db = getDb();
    const e = db.catalog.find((c) => c.id === params.id);
    if (!e) return notFound('Catalog entry');
    Object.assign(e, await request.json(), { updatedAt: new Date().toISOString() });
    return HttpResponse.json(e);
  }),
  http.post(P('/catalog/:id/versions'), async ({ params, request }) => {
    const db = getDb();
    const e = db.catalog.find((c) => c.id === params.id);
    if (!e) return notFound('Catalog entry');
    const body = (await request.json()) as { spec: CatalogVersion['spec'] };
    const v: CatalogVersion = {
      id: nextId('v'),
      entryId: e.id,
      label: body.spec.version,
      status: 'draft',
      spec: body.spec,
      test: null,
      changelog: '',
      createdAt: new Date().toISOString(),
      executableApproval: 'none',
    };
    db.versions[e.id] = [v, ...(db.versions[e.id] ?? [])];
    e.draftVersionId = v.id;
    return HttpResponse.json(v, { status: 201 });
  }),
  http.patch(P('/catalog/:id/versions/:vid'), async ({ params, request }) => {
    const v = (getDb().versions[String(params.id)] ?? []).find((x) => x.id === params.vid);
    if (!v) return notFound('Version');
    const body = (await request.json()) as { spec: CatalogVersion['spec'] };
    v.spec = body.spec;
    v.label = body.spec.version;
    v.test = null; // any change invalidates the previous test (11.3)
    return HttpResponse.json(v);
  }),
  http.post(P('/catalog/:id/versions/:vid/test'), ({ params }) => {
    const db = getDb();
    const v = (db.versions[String(params.id)] ?? []).find((x) => x.id === params.vid);
    if (!v) return notFound('Version');
    db.testStarts[v.id] = Date.now();
    const result = {
      ...fx.passingTest(v.label),
      status: 'running' as const,
      phases: fx.passingTest(v.label).phases.slice(0, 2),
      scan: [],
      stderr: ['npx -y …'],
    };
    v.test = result;
    return HttpResponse.json(result, { status: 202 });
  }),
  http.get(P('/catalog/:id/versions/:vid/test'), ({ params }) => {
    const db = getDb();
    const v = (db.versions[String(params.id)] ?? []).find((x) => x.id === params.vid);
    if (!v) return notFound('Version');
    const started = db.testStarts[v.id];
    if (started && Date.now() - started > 1200 && v.test?.status === 'running') {
      v.test = fx.passingTest(v.label);
      delete db.testStarts[v.id];
    }
    return HttpResponse.json(v.test);
  }),
  http.post(P('/catalog/:id/versions/:vid/publish'), ({ params }) => {
    const db = getDb();
    const e = db.catalog.find((c) => c.id === params.id);
    const v = (db.versions[String(params.id)] ?? []).find((x) => x.id === params.vid);
    if (!e || !v) return notFound('Version');
    if (v.test?.status !== 'passed') {
      return problem(
        409,
        'test_required',
        'Run a passing test first',
        'Publishing needs a passing test of this exact version.',
      );
    }
    v.status = 'published';
    e.status = 'published';
    e.currentVersion = v.label;
    e.draftVersionId = null;
    e.versionCount += 1;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(P('/catalog/:id/versions/:vid/approve-executable'), ({ params }) => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    const v = (db.versions[String(params.id)] ?? []).find((x) => x.id === params.vid);
    if (v) v.executableApproval = 'approved';
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/catalog/:id/versions/:vid/files'), () =>
    HttpResponse.json({ items: getDb().files.nodes, nextCursor: null }),
  ),
  http.get(P('/catalog/:id/versions/:vid/files/*'), ({ request }) => {
    const path = filePath(request.url);
    const f = getDb().files.files[path];
    return f ? HttpResponse.json(f) : notFound('File');
  }),
  http.put(P('/catalog/:id/versions/:vid/files/*'), async ({ request }) => {
    const path = filePath(request.url);
    const body = (await request.json()) as { content: string };
    const db = getDb();
    const prev = db.files.files[path];
    db.files.files[path] = {
      path,
      content: body.content,
      classification: prev?.classification ?? 'plain',
    };
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(P('/auto-install-policies'), ({ request }) =>
    paginate(getDb().autoInstall, new URL(request.url)),
  ),
  http.post(P('/auto-install-policies/:id/preview'), async ({ request }) => {
    const body = (await request.json()) as AutoInstallInput;
    const db = getDb();
    const teamTargets = body.targets.filter((t) => t.type === 'team');
    const everyone = body.targets.some((t) => t.type === 'all');
    const people = everyone
      ? 451
      : teamTargets.reduce(
          (n, t) => n + (db.teams.find((x) => x.id === t.id)?.memberCount ?? 0) * 21,
          0,
        ) || 12;
    return HttpResponse.json({
      people,
      teams: everyone ? db.teams.length : teamTargets.length,
      mustConnect: Math.round(people * 0.09),
      sample: db.users.slice(0, 12).map((u) => ({ id: u.id, name: u.name })),
    });
  }),
  http.post(P('/auto-install-policies'), async ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin', 'manager')) return forbidden();
    const body = (await request.json()) as AutoInstallInput;
    const p = {
      id: nextId('ap'),
      entryName: db.catalog.find((c) => c.id === body.entryId)?.displayName ?? body.entryId,
      ...body,
    };
    db.autoInstall.push(p);
    return HttpResponse.json(p, { status: 201 });
  }),
  http.patch(P('/auto-install-policies/:id'), async ({ params, request }) => {
    const p = getDb().autoInstall.find((x) => x.id === params.id);
    if (!p) return notFound('Policy');
    Object.assign(p, await request.json());
    return HttpResponse.json(p);
  }),
  http.delete(P('/auto-install-policies/:id'), ({ params }) => {
    const db = getDb();
    db.autoInstall = db.autoInstall.filter((x) => x.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Registry ------------------------------------------------------------------------------------------------
  http.get(P('/registry/servers'), ({ request }) => {
    const text = q(new URL(request.url), 'q').toLowerCase();
    return paginate(
      getDb().registry.filter(
        (s) => !text || `${s.name} ${s.description}`.toLowerCase().includes(text),
      ),
      new URL(request.url),
    );
  }),
  http.post(P('/registry/install'), async ({ request }) => {
    const db = getDb();
    const body = (await request.json()) as { sourceId: string; name: string; version: string };
    const server = db.registry.find((s) => s.name === body.name);
    if (!server) return notFound('Registry server');
    if (server.policy !== 'allowed')
      return problem(403, 'registry_policy', 'The registry policy requires a request');
    const short = body.name.split('/').pop() ?? body.name;
    const inst: Installation = {
      ...(fx.buildInstallations()[0] as Installation),
      id: nextId('i'),
      slug: short,
      toolPrefix: short.replace(/[^a-z0-9]/gi, '_'),
      displayName: short,
      letter: short.charAt(0).toUpperCase(),
      catalogEntryId: null,
      origin: 'registry',
      status: server.authMode === 'oauth' ? 'needs_setup' : 'ready',
      runtime: server.runtime,
      authMode: server.authMode,
      spark24: [],
    };
    db.installations.push(inst);
    return HttpResponse.json(inst, { status: 201 });
  }),
  http.get(P('/install-requests'), ({ request }) => {
    const db = getDb();
    const open = q(new URL(request.url), 'status') === 'open';
    const mine =
      db.role === 'member' ? db.requests.filter((r) => r.requesterId === db.me.id) : db.requests;
    return paginate(
      mine.filter((r) => !open || r.status === 'open'),
      new URL(request.url),
    );
  }),
  http.post(P('/install-requests'), async ({ request }) => {
    const db = getDb();
    const body = (await request.json()) as { sourceId: string; name: string; reason: string };
    const rq = {
      id: nextId('rq'),
      status: 'open' as const,
      requesterName: db.me.name,
      requesterId: db.me.id,
      teamName: db.me.teams[0]?.name ?? null,
      serverName: body.name,
      sourceName: db.registry.find((s) => s.name === body.name)?.sourceName ?? '',
      reason: body.reason,
      createdAt: new Date().toISOString(),
    };
    db.requests.unshift(rq);
    const s = db.registry.find((x) => x.name === body.name);
    if (s) s.requested = true;
    return HttpResponse.json(rq, { status: 201 });
  }),
  http.post(P('/install-requests/:id/:decision'), ({ params }) => {
    const db = getDb();
    if (!roleIs(db, 'admin', 'manager')) return forbidden();
    const rq = db.requests.find((r) => r.id === params.id);
    if (rq) rq.status = params.decision === 'approve' ? 'approved' : 'rejected';
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Access ------------------------------------------------------------------------------------------------------
  http.get(P('/users'), ({ request }) => {
    const db = getDb();
    if (db.role === 'member') return forbidden();
    const url = new URL(request.url);
    const text = q(url, 'q').toLowerCase();
    const team = q(url, 'teamId');
    return paginate(
      db.users.filter(
        (u) =>
          (!text || `${u.name} ${u.email}`.toLowerCase().includes(text)) &&
          (!team || u.teams.some((t) => t.id === team)),
      ),
      url,
    );
  }),
  http.post(P('/users/:id/deactivate'), ({ params }) => {
    const u = getDb().users.find((x) => x.id === params.id);
    if (u) u.status = 'deactivated';
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/teams'), ({ request }) => {
    const db = getDb();
    if (db.role === 'member') return forbidden();
    return paginate(db.teams, new URL(request.url));
  }),
  http.post(P('/teams'), async ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    const body = (await request.json()) as { name: string };
    const team = { id: nextId('t'), name: body.name, memberCount: 0, managers: [], members: [] };
    db.teams.push(team);
    return HttpResponse.json(team, { status: 201 });
  }),
  http.put(P('/teams/:id/members/:userId'), async ({ params, request }) => {
    const db = getDb();
    const team = db.teams.find((t) => t.id === params.id);
    const user = db.users.find((u) => u.id === params.userId);
    if (!team || !user) return notFound('Team or user');
    const body = (await request.json()) as { role: 'manager' | 'member' };
    team.members = team.members
      .filter((m) => m.userId !== user.id)
      .concat({ userId: user.id, name: user.name, role: body.role });
    team.memberCount = team.members.length;
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete(P('/teams/:id/members/:userId'), ({ params }) => {
    const team = getDb().teams.find((t) => t.id === params.id);
    if (team) {
      team.members = team.members.filter((m) => m.userId !== params.userId);
      team.memberCount = team.members.length;
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/role-mapping-rules'), ({ request }) =>
    paginate(getDb().roleMapping, new URL(request.url)),
  ),
  http.post(P('/role-mapping-rules'), async ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    const rule = {
      id: nextId('rm'),
      ...((await request.json()) as object),
    } as MockDb['roleMapping'][number];
    db.roleMapping.push(rule);
    return HttpResponse.json(rule, { status: 201 });
  }),
  http.patch(P('/role-mapping-rules/:id'), async ({ params, request }) => {
    const r = getDb().roleMapping.find((x) => x.id === params.id);
    if (!r) return notFound('Rule');
    Object.assign(r, await request.json());
    return HttpResponse.json(r);
  }),
  http.delete(P('/role-mapping-rules/:id'), ({ params }) => {
    const db = getDb();
    db.roleMapping = db.roleMapping.filter((r) => r.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/service-accounts'), ({ request }) =>
    paginate(getDb().serviceAccounts, new URL(request.url)),
  ),
  http.post(P('/service-accounts'), async ({ request }) => {
    const db = getDb();
    const body = (await request.json()) as { name: string; teamId: string };
    const sa = {
      id: nextId('sa'),
      name: body.name,
      teamId: body.teamId,
      teamName: db.teams.find((t) => t.id === body.teamId)?.name ?? '',
      credentials: 0,
      createdAt: new Date().toISOString(),
    };
    db.serviceAccounts.push(sa);
    return HttpResponse.json(sa, { status: 201 });
  }),
  http.delete(P('/service-accounts/:id'), ({ params }) => {
    const db = getDb();
    db.serviceAccounts = db.serviceAccounts.filter((s) => s.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/oauth-clients'), ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    return paginate(db.oauthClients, new URL(request.url));
  }),
  http.patch(P('/oauth-clients/:id'), async ({ params, request }) => {
    const c = getDb().oauthClients.find((x) => x.id === params.id);
    if (!c) return notFound('Client');
    Object.assign(c, await request.json());
    return HttpResponse.json(c);
  }),
  http.get(P('/policy-rules'), ({ request }) => {
    const db = getDb();
    return paginate(
      db.policyRules.map((r) => ({
        ...r,
        canEdit: roleIs(db, 'admin') || (roleIs(db, 'manager') && !r.orgLevel),
      })),
      new URL(request.url),
    );
  }),
  http.post(P('/policy-rules/preview'), async ({ request }) => {
    const body = (await request.json()) as PolicyRuleInput;
    return HttpResponse.json({
      people: Math.max(1, body.who.length * 38),
      tools: Math.max(1, body.what.length * 3),
    });
  }),
  http.post(P('/policy-rules'), async ({ request }) => {
    const db = getDb();
    const body = (await request.json()) as PolicyRuleInput;
    const rule = {
      id: nextId('pr'),
      ...body,
      affected: { people: body.who.length * 38, tools: body.what.length * 3 },
      orgLevel: false,
      canEdit: true,
    };
    db.policyRules.unshift(rule);
    return HttpResponse.json(rule, { status: 201 });
  }),
  http.patch(P('/policy-rules/:id'), async ({ params, request }) => {
    const r = getDb().policyRules.find((x) => x.id === params.id);
    if (!r) return notFound('Rule');
    Object.assign(r, await request.json());
    return HttpResponse.json(r);
  }),
  http.delete(P('/policy-rules/:id'), ({ params }) => {
    const db = getDb();
    db.policyRules = db.policyRules.filter((r) => r.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/custom-policies'), ({ request }) => {
    if (!roleIs(getDb(), 'admin')) return forbidden();
    return paginate(getDb().customPolicies, new URL(request.url));
  }),
  http.post(P('/custom-policies'), async ({ request }) => {
    const db = getDb();
    const p = {
      id: nextId('cp'),
      ...((await request.json()) as object),
    } as MockDb['customPolicies'][number];
    db.customPolicies.push(p);
    return HttpResponse.json(p, { status: 201 });
  }),
  http.patch(P('/custom-policies/:id'), async ({ params, request }) => {
    const p = getDb().customPolicies.find((x) => x.id === params.id);
    if (!p) return notFound('Policy');
    Object.assign(p, await request.json());
    return HttpResponse.json(p);
  }),
  http.delete(P('/custom-policies/:id'), ({ params }) => {
    const db = getDb();
    db.customPolicies = db.customPolicies.filter((x) => x.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(P('/policies/validate'), async ({ request }) => {
    const { cedar } = (await request.json()) as { cedar: string };
    const errors: { line: number; message: string }[] = [];
    const lines = cedar.split('\n');
    const open = (cedar.match(/\(/g) ?? []).length;
    const close = (cedar.match(/\)/g) ?? []).length;
    if (open !== close) errors.push({ line: lines.length, message: 'Unbalanced parentheses' });
    if (!/\b(permit|forbid)\b/.test(cedar))
      errors.push({ line: 1, message: 'A policy starts with permit or forbid' });
    if (
      !/;\s*$/.test(
        cedar
          .trim()
          .replace(/\/\/.*$/gm, '')
          .trim(),
      )
    )
      errors.push({ line: lines.length, message: 'A policy ends with ;' });
    return HttpResponse.json({ valid: errors.length === 0, errors });
  }),
  http.post(P('/policies/simulate'), async ({ request }) => {
    const input = (await request.json()) as SimulationInput;
    const db = getDb();
    const user = db.users.find((u) => u.id === input.userId);
    const supportDeny = user?.teams.some((t) => t.id === 't-support') && /slack/.test(input.tool);
    if (supportDeny) {
      return HttpResponse.json({
        decision: 'deny',
        summary: 'Decided by the forbid rule on destructive Slack tools',
        matches: [
          {
            id: 'rule-support-no-destructive',
            effect: 'forbid',
            label: 'rule-support-no-destructive',
            deciding: true,
          },
          {
            id: 'installation-default',
            effect: 'permit',
            label: 'installation default',
            deciding: false,
          },
        ],
      });
    }
    return HttpResponse.json({
      decision: 'permit',
      summary: 'Allowed by the installation default',
      matches: [
        {
          id: 'installation-default',
          effect: 'permit',
          label: 'installation default',
          deciding: true,
        },
      ],
    });
  }),

  // --- Settings and system -----------------------------------------------------------------------------------------
  http.get(P('/settings'), () => {
    const db = getDb();
    if (!roleIs(db, 'admin', 'manager', 'auditor')) return forbidden();
    return etagged(db.settings, 'settings-1');
  }),
  http.patch(P('/settings'), async ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    const patch = (await request.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      const cur = (db.settings as unknown as Record<string, unknown>)[k];
      (db.settings as unknown as Record<string, unknown>)[k] =
        cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur, ...(v as object) } : v;
    }
    return etagged(db.settings, 'settings-2');
  }),
  http.get(P('/idp-connections'), ({ request }) => {
    if (!roleIs(getDb(), 'admin')) return forbidden();
    return paginate(getDb().idp, new URL(request.url));
  }),
  http.post(P('/idp-connections'), async ({ request }) => {
    const db = getDb();
    const body = (await request.json()) as Partial<MockDb['idp'][number]>;
    const idp = {
      id: nextId('idp'),
      name: '',
      issuer: '',
      clientId: '',
      scopes: ['openid', 'email', 'profile'],
      domains: [],
      status: 'untested' as const,
      lastTestAt: null,
      ...body,
    };
    db.idp.push(idp);
    return HttpResponse.json(idp, { status: 201 });
  }),
  http.patch(P('/idp-connections/:id'), async ({ params, request }) => {
    const i = getDb().idp.find((x) => x.id === params.id);
    if (!i) return notFound('Connection');
    Object.assign(i, await request.json());
    return HttpResponse.json(i);
  }),
  http.post(P('/idp-connections/:id/test'), async ({ params }) => {
    await latency();
    const i = getDb().idp.find((x) => x.id === params.id);
    if (!i) return notFound('Connection');
    const ok = i.issuer.startsWith('https://');
    i.status = ok ? 'ok' : 'error';
    i.lastTestAt = new Date().toISOString();
    return HttpResponse.json({
      ok,
      steps: [
        {
          name: 'Discovery document',
          ok,
          detail: ok ? `${i.issuer}/.well-known/openid-configuration` : 'The issuer must use https',
        },
        { name: 'JWKS reachable', ok, detail: ok ? '2 keys' : 'Skipped' },
        {
          name: 'Client credentials',
          ok,
          detail: ok ? 'Token endpoint accepted the client' : 'Skipped',
        },
      ],
    });
  }),
  http.get(P('/settings/model-guards'), () => HttpResponse.json(getDb().modelGuards)),
  http.put(P('/settings/model-guards'), async ({ request }) => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    db.modelGuards = (await request.json()) as MockDb['modelGuards'];
    return HttpResponse.json(db.modelGuards);
  }),
  http.get(P('/limit-rules'), ({ request }) => paginate(getDb().limits, new URL(request.url))),
  http.post(P('/limit-rules'), async ({ request }) => {
    const db = getDb();
    const rule = {
      id: nextId('lr'),
      ...((await request.json()) as object),
    } as MockDb['limits'][number];
    db.limits.push(rule);
    return HttpResponse.json(rule, { status: 201 });
  }),
  http.patch(P('/limit-rules/:id'), async ({ params, request }) => {
    const r = getDb().limits.find((x) => x.id === params.id);
    if (!r) return notFound('Rule');
    Object.assign(r, await request.json());
    return HttpResponse.json(r);
  }),
  http.delete(P('/limit-rules/:id'), ({ params }) => {
    const db = getDb();
    db.limits = db.limits.filter((x) => x.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/system/status'), () => {
    const db = getDb();
    if (!roleIs(db, 'admin')) return forbidden();
    return HttpResponse.json(fx.buildSystem(db.now));
  }),
  http.post(P('/system/kms/rotate'), () => new HttpResponse(null, { status: 204 })),

  // --- Plugins ---------------------------------------------------------------------------------------------------------
  http.get(P('/marketplaces'), ({ request }) => {
    const db = getDb();
    return paginate(
      db.marketplaces.map((m) => ({ ...m, canManage: roleIs(db, 'admin', 'manager') })),
      new URL(request.url),
    );
  }),
  http.get(P('/marketplaces/:id'), ({ params }) => {
    const db = getDb();
    const m = db.marketplaceDetails[String(params.id)];
    return m
      ? HttpResponse.json({ ...m, canManage: roleIs(db, 'admin', 'manager') })
      : notFound('Marketplace');
  }),
  http.post(P('/marketplaces/:id/releases/:n/promote'), ({ params }) => {
    const m = getDb().marketplaceDetails[String(params.id)];
    if (!m) return notFound('Marketplace');
    for (const r of m.releases) {
      r.promoted = r.n === Number(params.n);
      if (r.n === Number(params.n)) r.draft = false;
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(P('/marketplaces/:id/mirror/push'), ({ params }) => {
    const m = getDb().marketplaceDetails[String(params.id)];
    if (m) m.mirror = { ...m.mirror, status: 'in_sync', lastPushAt: new Date().toISOString() };
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(P('/marketplaces/:id/rollout'), ({ request }) => {
    const client = q(new URL(request.url), 'client') || 'claude-code';
    const url = `https://${fx.HOST}/plugins/acme.git`;
    const rollout = {
      'claude-code': {
        label: 'Claude Code managed settings',
        kind: 'snippet',
        content: JSON.stringify(
          {
            extraKnownMarketplaces: { acme: { source: { source: 'git', url }, autoUpdate: true } },
            enabledPlugins: { 'security-review@acme': true },
          },
          null,
          2,
        ),
      },
      codex: {
        label: 'Codex requirements.toml',
        kind: 'snippet',
        content: `[marketplaces]\nrestrict_to_allowed_sources = true\n\n[marketplaces.allowed_sources.acme]\nsource = "git"\nurl = "${url}"\n`,
      },
      'claude-desktop-3p': {
        label: 'Claude Desktop (third-party cloud)',
        kind: 'snippet',
        content: JSON.stringify(
          {
            allowedPluginMarketplaces: [
              {
                source: 'git',
                url,
                ref: '58d0f4a',
                credentialKind: 'credentialHelper',
                credentialHelper: '/usr/local/bin/bastion-credential',
                installationPreference: 'available',
              },
            ],
          },
          null,
          2,
        ),
      },
      'claude-ai': {
        label: 'claude.ai organization settings',
        kind: 'checklist',
        content:
          '1. Organization settings, Plugins and skills, Marketplaces: add github.com/acme/bastion-plugins.\n2. Set Security review to Required.\n3. Set Release notes to Installed by default.\n4. Leave the others Available.',
      },
      chatgpt: {
        label: 'ChatGPT workspace admin',
        kind: 'checklist',
        content:
          '1. Admin, Plugins, Import marketplace: paste the GitHub mirror URL.\n2. Match each plugin’s installation policy per role.\n3. Plugins with MCP servers show as Desktop only.',
      },
    }[client] ?? { label: client, kind: 'snippet', content: '' };
    return HttpResponse.json({ client, ...rollout });
  }),

  // --- Live updates (18.1) ------------------------------------------------------------------------------------------------
  sse(P('/events'), ({ client, request }) => {
    SSE_CLIENTS.add(client);
    request.signal.addEventListener('abort', () => SSE_CLIENTS.delete(client));
  }),
];

export type { ClientId };
