import { delay, HttpResponse, http, sse } from 'msw';
import type { Schemas } from '@/api/schema';
import type {
  CallFilters,
  ClientConfig,
  ClientId,
  EgressEntry,
  Installation,
  InstallationInput,
  OverrideDocument,
  UiRole,
} from '@/api/types';
import { getDb, type MockDb, nextId, setRole } from './db';
import { accessHandlers } from './domains/access';
import { catalogHandlers } from './domains/catalog';
import { observabilityHandlers } from './domains/observability';
import { pluginsHandlers } from './domains/plugins';
import { registryHandlers } from './domains/registry';
import { serversHandlers } from './domains/servers';
import { sessionHandlers } from './domains/session';
import { settingsHandlers } from './domains/settings';
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
    getDb().data.session.notifications.unshift(data as Schemas['Notification']);
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

  // Typed handlers of the domains that moved to the generated API types answer first; the legacy handlers
  // below answer the routes of the screens that have not moved yet.
  ...sessionHandlers,
  ...accessHandlers,
  ...settingsHandlers,
  ...catalogHandlers,
  ...serversHandlers,
  ...observabilityHandlers,
  ...registryHandlers,
  ...pluginsHandlers,

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
  http.get(P('/installations/:id/egress'), ({ params }) => {
    const hosts = getDb().egress[String(params.id)]?.hosts ?? [];
    const items: EgressEntry[] = hosts.map((h) => ({
      ts: h.lastSeenAt ?? new Date().toISOString(),
      host: h.host,
      port: 443,
      decision: h.status,
    }));
    return HttpResponse.json({ items, nextCursor: null });
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
