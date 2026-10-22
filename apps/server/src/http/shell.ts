/**
 * Security headers, CORS and the static SPA of the ui role (9.2, 24.2): strict CSP (`default-src 'self'`, no inline
 * scripts, `frame-ancestors 'none'`), HSTS through `@fastify/helmet`, restricted CORS through `@fastify/cors`, and
 * `@fastify/static` with the SPA fallback for client-side routes.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { IMMUTABLE_CACHE_CONTROL, IMMUTABLE_MAX_AGE_SECONDS } from '../timing';

/** Path prefixes owned by something other than the SPA: unknown paths below them answer 404, never index.html. */
const API_PREFIXES = [
  '/api/',
  '/oauth',
  '/mcp',
  '/scim/',
  '/registry/',
  '/plugins/',
  '/auth/',
  '/connect/',
  '/.well-known/',
  '/internal/',
];

/**
 * Console routes that live below an API prefix (`/registry` is the Registry screen, `/registry/v0.1/*` the subregistry;
 * `/plugins/marketplace/:id` and `/plugins/edit/:id` are screens, the rest of `/plugins/` is the git distribution):
 * a browser reload of them must get the SPA, not a JSON 404.
 */
const isSpaRoute = (path: string): boolean =>
  path === '/registry' ||
  path.startsWith('/plugins/marketplace/') ||
  path.startsWith('/plugins/edit/');

export const resolvePublicDir = (override?: string): string | undefined => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    override,
    join(here, '..', 'public'),
    join(here, '..', '..', 'public'),
    join(process.cwd(), 'public'),
  ].filter((p): p is string => typeof p === 'string');
  return candidates.find((p) => existsSync(join(p, 'index.html')));
};

/** `default-src 'self'`, no inline scripts; inline styles are allowed because the component library sets `style` attributes. */
export const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
} as const;

export type ShellOptions = {
  publicUrl: string;
  extraOrigins?: string[] | undefined;
  publicDir?: string | undefined;
};

/** Public documents any browser-based MCP client may read (metadata, JWKS, token and registration endpoints). */
const isPublicCorsPath = (url: string): boolean =>
  url === '/mcp' ||
  url.startsWith('/mcp/') ||
  url.startsWith('/mcp?') ||
  url.startsWith('/.well-known/') ||
  url.startsWith('/oauth/jwks') ||
  url.startsWith('/oauth/token') ||
  url.startsWith('/oauth/reg') ||
  url.startsWith('/oauth/upstream/client-metadata.json') ||
  url.startsWith('/oauth/upstream/client-metadata-public.json') ||
  url.startsWith('/oauth/upstream/jwks');

export const registerSecurityHeaders = async (
  app: FastifyInstance,
  options: ShellOptions,
): Promise<void> => {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    hsts: { maxAge: IMMUTABLE_MAX_AGE_SECONDS, includeSubDomains: true },
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  const allowed = new Set([new URL(options.publicUrl).origin, ...(options.extraOrigins ?? [])]);
  await app.register(cors, {
    delegator: (req, callback) => {
      const origin = req.headers.origin;
      const url = req.url ?? '/';
      if (isPublicCorsPath(url)) {
        callback(null, {
          origin: '*',
          credentials: false,
          maxAge: 600,
          allowedHeaders: [
            'content-type',
            'authorization',
            'accept',
            'mcp-protocol-version',
            'mcp-session-id',
            'last-event-id',
          ],
          exposedHeaders: ['www-authenticate', 'mcp-session-id'],
        });
        return;
      }
      callback(null, {
        origin: origin !== undefined && allowed.has(origin) ? origin : false,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'content-type',
          'authorization',
          'if-match',
          'idempotency-key',
          'x-bastion-csrf',
        ],
        exposedHeaders: ['etag', 'location', 'x-request-id'],
        maxAge: 600,
      });
    },
  });
};

/** Serves the SPA from `public/` with the index.html fallback. Returns false when no build is present. */
export const registerSpa = async (
  app: FastifyInstance,
  options: ShellOptions,
): Promise<boolean> => {
  const root = resolvePublicDir(options.publicDir);
  if (!root) return false;
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: ['index.html'],
    cacheControl: true,
    maxAge: '1h',
    setHeaders: (res, path) => {
      // Fingerprinted assets are immutable; the shell must always be revalidated.
      if (path.includes(`${join(root, 'assets')}`)) {
        res.header('cache-control', IMMUTABLE_CACHE_CONTROL);
      } else if (path.endsWith('index.html')) {
        res.header('cache-control', 'no-cache');
      }
    },
  });
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const accepts = String(req.headers.accept ?? '');
    const isApi =
      !isSpaRoute(path) &&
      API_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
    if (
      req.method === 'GET' &&
      !isApi &&
      (accepts.includes('text/html') || accepts === '' || accepts === '*/*')
    ) {
      return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html');
    }
    return reply.code(404).type('application/json').send({ error: 'not_found' });
  });
  return true;
};
