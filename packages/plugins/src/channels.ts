import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { HEADERS, SCOPES } from '@bastion-mcp/core';
import { BodyTooLargeError, readBodyCapped } from './body';
import type { GitRepositoryCache } from './git-cache';
import { runHttpBackend } from './http-backend';
import type {
  Clock,
  DistributionEvent,
  DistributionEventSink,
  MarketplaceRow,
  MarketplaceStore,
  PluginAccess,
  PluginPrincipal,
  ReleaseStore,
} from './ports';
import { systemClock } from './ports';
import { archiveFileName, type ReleaseRecord, renderHttpsManifest } from './release';
import type { ReleaseService } from './release-service';

export const BASIC_REALM = 'Bastion plugins';
const SLUG = '[a-z0-9][a-z0-9-]{1,62}';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export type PluginsHandlerDeps = {
  host: string;
  access: PluginAccess;
  marketplaces: MarketplaceStore;
  releases: ReleaseStore;
  releaseService: ReleaseService;
  repositories: GitRepositoryCache;
  events: DistributionEventSink;
  clock?: Clock;
  /** Path of the git binary; defaults to `git` on PATH. */
  gitBinary?: string;
};

const unauthorized = (): Response =>
  new Response('Authentication required\n', {
    status: 401,
    headers: { 'www-authenticate': `Basic realm="${BASIC_REALM}"`, 'cache-control': 'no-store' },
  });

const notFound = (): Response =>
  new Response('Not found\n', { status: 404, headers: { 'cache-control': 'no-store' } });

const text = (status: number, body: string): Response =>
  new Response(`${body}\n`, { status, headers: { 'cache-control': 'no-store' } });

/** The secret from `Authorization: Basic base64(user:token)` or `Bearer <token>` (25.5). */
export const extractCredential = (header: string | null): string | undefined => {
  if (!header) return undefined;
  const match = /^(\S+)\s+(\S.*)$/.exec(header);
  if (!match?.[1] || !match[2]) return undefined;
  const scheme = match[1].toLowerCase();
  const value = match[2];
  if (scheme === 'bearer') return value.trim() || undefined;
  if (scheme === 'basic') {
    const decoded = Buffer.from(value.trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const password = colon < 0 ? '' : decoded.slice(colon + 1);
    return password || undefined;
  }
  return undefined;
};

type Route =
  | { kind: 'git'; slug: string; rest: string }
  | { kind: 'manifest'; slug: string }
  | { kind: 'archive'; slug: string; file: string };

const parseRoute = (pathname: string): Route | undefined => {
  let m = new RegExp(`^/plugins/(${SLUG})\\.git(/.*)$`).exec(pathname);
  if (m?.[1] && m[2]) return { kind: 'git', slug: m[1], rest: m[2] };
  m = new RegExp(`^/plugins/(${SLUG})/marketplace\\.json$`).exec(pathname);
  if (m?.[1]) return { kind: 'manifest', slug: m[1] };
  m = new RegExp(`^/plugins/(${SLUG})/archives/([A-Za-z0-9._+-]+\\.zip)$`).exec(pathname);
  if (m?.[1] && m[2]) return { kind: 'archive', slug: m[1], file: m[2] };
  return undefined;
};

/**
 * The `/plugins/*` handler (25.5): git smart HTTP (upload-pack only), the HTTPS manifest and the
 * archives. Returns `undefined` for paths it does not own so a server can fall through. Mount it
 * with `toNodeListener` or call it with any `Request`.
 */
export const createPluginsHandler = (
  deps: PluginsHandlerDeps,
): ((request: Request) => Promise<Response | undefined>) => {
  const clock = deps.clock ?? systemClock;

  const record = async (
    principal: PluginPrincipal,
    marketplace: MarketplaceRow,
    request: Request,
    channel: DistributionEvent['channel'],
    action: DistributionEvent['action'],
    releaseSeq: number | null,
  ): Promise<void> => {
    try {
      await deps.events.record({
        ts: clock.now(),
        principalId: principal.id,
        marketplaceId: marketplace.id,
        releaseSeq,
        channel,
        action,
        userAgent: request.headers.get('user-agent'),
      });
    } catch {
      // Usage accounting never blocks a fetch (25.9).
    }
  };

  const selectRelease = async (
    marketplace: MarketplaceRow,
    url: URL,
  ): Promise<ReleaseRecord | Response> => {
    const wanted = url.searchParams.get('release');
    if (wanted !== null) {
      const seq = /^[1-9]\d{0,8}$/.test(wanted) ? Number(wanted) : Number.NaN;
      if (Number.isNaN(seq)) return text(400, 'invalid release');
      return (await deps.releases.get(marketplace.id, seq)) ?? notFound();
    }
    return (await deps.releases.latest(marketplace.id)) ?? notFound();
  };

  return async (request) => {
    const url = new URL(request.url);
    const route = parseRoute(url.pathname);
    if (!route) return undefined;

    const secret = extractCredential(request.headers.get('authorization'));
    if (!secret) return unauthorized();
    const principal = await deps.access.authenticate(secret);
    if (!principal) return unauthorized();
    if (!principal.scopes.includes(SCOPES.pluginsRead))
      return text(403, 'scope plugins:read required');

    const marketplace = await deps.marketplaces.getBySlug(route.slug);
    if (!marketplace || !(await deps.access.canView(principal, marketplace))) return notFound();

    if (route.kind === 'git') {
      const isRefs = route.rest === '/info/refs';
      const isPack = route.rest === '/git-upload-pack';
      if (!isRefs && !isPack) return notFound(); // the dumb protocol and everything else
      if (isRefs) {
        if (request.method !== 'GET') return text(405, 'method not allowed');
        const service = url.searchParams.get('service');
        if (service === 'git-receive-pack') return text(403, 'read-only repository');
        if (service !== 'git-upload-pack') return notFound();
      } else if (request.method !== 'POST') return text(405, 'method not allowed');

      const latest = await deps.releases.latest(marketplace.id);
      if (!latest) return notFound();
      let body: Uint8Array;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return text(413, 'request body too large');
        throw error;
      }
      const repo = await deps.repositories.ensure(marketplace, latest.seq);
      const response = await runHttpBackend({
        ...(deps.gitBinary ? { gitBinary: deps.gitBinary } : {}),
        root: repo.root,
        pathInfo: `/repo.git${route.rest}`,
        query: url.searchParams.toString(),
        method: request.method,
        contentType: request.headers.get('content-type'),
        contentEncoding: request.headers.get('content-encoding'),
        gitProtocol: request.headers.get('git-protocol'),
        body,
      });
      if (isRefs) await record(principal, marketplace, request, 'git', 'git_fetch', latest.seq);
      return response;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD')
      return text(405, 'method not allowed');
    const selected = await selectRelease(marketplace, url);
    if (selected instanceof Response) return selected;
    const built = await deps.releaseService.getBuilt(marketplace, selected);

    if (route.kind === 'manifest') {
      const bytes = renderHttpsManifest(built.claudeManifest, selected, {
        host: deps.host,
        slug: marketplace.slug,
      });
      await record(principal, marketplace, request, 'https', 'manifest_fetch', selected.seq);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'private, no-cache',
          [HEADERS.release]: String(selected.seq),
        },
      });
    }

    const archive = [...built.archives.values()].find(
      (a) => archiveFileName(a.plugin, a.version) === route.file,
    );
    if (!archive) return notFound();
    await record(principal, marketplace, request, 'https', 'archive_download', selected.seq);
    return new Response(Buffer.from(archive.bytes), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${route.file}"`,
        'cache-control': 'private, no-cache',
        etag: `"${archive.sha256}"`,
        [HEADERS.release]: String(selected.seq),
      },
    });
  };
};

const readBody = async (request: Request): Promise<Uint8Array> => {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLargeError(MAX_BODY_BYTES);
  return readBodyCapped(request.body, MAX_BODY_BYTES);
};

/** Adapts the `Request` handler to a Node `http` listener; paths it does not own answer 404. */
export const toNodeListener =
  (
    handler: (request: Request) => Promise<Response | undefined>,
    options: { origin?: string } = {},
  ): ((req: IncomingMessage, res: ServerResponse) => void) =>
  (req, res) => {
    const origin = options.origin ?? `http://${req.headers.host ?? 'localhost'}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else if (value !== undefined) headers.set(name, value);
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(new URL(req.url ?? '/', origin), {
      method,
      headers,
      ...(hasBody
        ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
        : {}),
    });
    handler(request)
      .then(async (response) => {
        if (!response) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.statusCode = response.status;
        response.headers.forEach((value, name) => {
          res.setHeader(name, value);
        });
        if (!response.body) {
          res.end();
          return;
        }
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
      })
      .catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  };
