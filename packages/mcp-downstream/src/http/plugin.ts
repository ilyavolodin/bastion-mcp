/**
 * `registerMcpRoutes` (4.4, 6.2, 6.9, 7.1): the Fastify plugin for `/mcp`, `/mcp/e/{slug}`, `/mcp/i/{slug}`,
 * `/mcp/c/{slug}` and the Protected Resource Metadata routes.
 *
 * Hook order: per-IP flood limit (before body parsing) -> raw-buffer body parser -> token verification (401 and 403
 * challenges) -> `request.raw.auth` -> endpoint resolution through `EndpointCache` (Cedar `useInstallation` is part of
 * the compilation) -> `AsyncLocalStorage` `bastionRequestContext` -> `subscriptions/listen` interception ->
 * `isLegacyRequest` branch -> 415 for non-JSON POSTs.
 */
import {
  AuthenticationError,
  endpointAllowed,
  InsufficientScopeError,
  type Principal,
} from '@bastion-mcp/auth';
import { type BastionError, isBastionError, sha256Hex } from '@bastion-mcp/core';
import { floodBucketFor, type FloodLimiter } from '@bastion-mcp/limits';
import {
  type EndpointCache,
  type ParsedEndpointPath,
  parseEndpointPath,
  protectedResourceMetadata,
} from '@bastion-mcp/router';
import { SPAN_NAMES } from '@bastion-mcp/telemetry';
import {
  hostHeaderValidationResponse,
  isJsonContentType,
  isLegacyRequest,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { type Tracer, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Exchange, LegacyAdapter, ListenAdapter } from '../adapters/contracts';
import { createDirectHandler, isDirectExchange } from '../adapters/modern/direct';
import type { ModernAdapter } from '../adapters/modern/server';
import { type BastionRequestContext, bastionRequestContext } from '../context';
import type { CatalogInstallPort, Logger, TokenVerifierPort } from '../ports';
import { toRpcErrorBody } from '../rpc';
import type { JsonObject, ResolvedEndpoint } from '../types';
import type { EndpointResolver } from './resolver';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type HttpDeps = {
  verifier: TokenVerifierPort;
  flood: FloodLimiter;
  resolver: EndpointResolver;
  endpointCache: EndpointCache;
  catalogInstall?: CatalogInstallPort | undefined;
  modern: ModernAdapter;
  legacy: LegacyAdapter;
  listen: ListenAdapter;
  direct: ReturnType<typeof createDirectHandler>;
  /** `BASTION_PUBLIC_URL`: only its value is trusted, never the Host header (9.3). */
  baseUrl: string;
  authorizationServers: string[];
  scopesSupported?: string[];
  /** Host and Origin validation (DNS rebinding protection); off when unset. */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  tracer: Tracer;
  logger: Logger;
  isDraining: () => boolean;
  /** Tracks in-flight exchanges so shutdown can drain them (21.2). */
  track: <T>(fn: () => Promise<T>) => Promise<T>;
};

type Prepared = {
  principal: Principal;
  token: string;
  resolved: ResolvedEndpoint;
  endpointPath: ParsedEndpointPath;
  origin: 'client' | 'plugin';
};

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const rpcError = (code: number, message: string, data?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: null,
  error: { code, message, ...(data ? { data } : {}) },
});

const bearerToken = (authorization: string | undefined): string => {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1] ?? '';
};

const toWebRequest = (req: FastifyRequest, baseUrl: string): Request => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  return new Request(new URL(req.url, baseUrl), { method: req.method, headers });
};

export const registerMcpRoutes = async (app: FastifyInstance, deps: HttpDeps): Promise<void> => {
  const prepared = new WeakMap<FastifyRequest, Prepared>();

  // Protected Resource Metadata (RFC 9728): public, each URL returns its own exact URL as `resource` (7.1).
  await app.register(async (scope) => {
    scope.get('/.well-known/oauth-protected-resource/*', async (req, reply) => {
      const pathname = req.url.split('?')[0] ?? req.url;
      const doc = protectedResourceMetadata(pathname, {
        baseUrl: deps.baseUrl,
        authorizationServers: deps.authorizationServers,
        scopesSupported: deps.scopesSupported ?? ['mcp'],
      });
      if (!doc) return reply.code(404).send({ error: 'not_found' });
      return reply.header('cache-control', 'public, max-age=300').send(doc);
    });
  });

  await app.register(async (scope) => {
    // The raw body is parsed once, here: the SDK handler and the adapters take the parsed value (6.2).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_req, body, done) => {
      done(null, body);
    });

    // 1. Per-IP flood limit, before body parsing (14.2, 6.9).
    scope.addHook('onRequest', async (req, reply) => {
      const bucket = floodBucketFor(req.url);
      if (bucket) {
        const verdict = await deps.flood.check(req.ip, bucket);
        if (!verdict.ok) {
          return reply
            .code(429)
            .header('retry-after', String(verdict.retryAfterSec))
            .send({ error: 'too_many_requests' });
        }
      }
      if (deps.allowedHosts || deps.allowedOrigins) {
        const web = toWebRequest(req, deps.baseUrl);
        const rejected =
          (deps.allowedHosts ? hostHeaderValidationResponse(web, deps.allowedHosts) : undefined) ??
          (deps.allowedOrigins ? originValidationResponse(web, deps.allowedOrigins) : undefined);
        if (rejected) {
          return reply
            .code(rejected.status)
            .header('content-type', 'application/json')
            .send(await rejected.text());
        }
      }
      if (deps.isDraining()) {
        return reply.code(503).header('retry-after', '1').send({ error: 'draining' });
      }
    });

    // 2. Token verification, endpoint resolution (after the body parser).
    scope.addHook('preHandler', async (req, reply) => {
      const outcome = await authenticate(req, reply);
      if (outcome) return reply;
      return undefined;
    });

    const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      const pathname = (req.url.split('?')[0] ?? req.url).replace(/\/+$/, '') || '/';
      const parsed = parseEndpointPath(pathname);
      if (!parsed) {
        await reply.code(404).send({ error: 'not_found' });
        return true;
      }
      const requestUrl = new URL(req.url, deps.baseUrl).toString();
      let principal: Principal;
      try {
        principal = await deps.tracer.startActiveSpan(
          SPAN_NAMES.authn,
          { kind: SpanKind.INTERNAL },
          async (span) => {
            try {
              return await deps.verifier.verify(header(req.headers.authorization), requestUrl);
            } catch (error) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'authentication failed' });
              throw error;
            } finally {
              span.end();
            }
          },
        );
      } catch (error) {
        await sendAuthError(reply, error, deps.logger);
        return true;
      }
      let origin: 'client' | 'plugin' = 'client';
      if (parsed.kind === 'catalog') {
        origin = 'plugin';
        if (!deps.catalogInstall) {
          await reply.code(404).send({ error: 'not_found' });
          return true;
        }
        const ensured = await deps.catalogInstall.ensure(principal, parsed.slug);
        if (ensured.status === 'not_found') {
          await reply.code(404).send({ error: 'not_found' });
          return true;
        }
        if (ensured.created) deps.endpointCache.invalidate({ scope: 'user', id: principal.id });
      }
      const resolved = await deps.resolver.resolve(principal, parsed, {
        clientId: principal.clientId ?? '',
        clientName: '',
        ip: req.ip,
        authMethod: principal.authMethod,
        path: pathname,
      });
      // Hidden and nonexistent endpoints look alike; an empty single-installation endpoint is not served (6.9).
      const single = parsed.kind === 'installation' || parsed.kind === 'catalog';
      if (!resolved || (single && resolved.endpoint.installations.length === 0)) {
        await reply.code(404).send({ error: 'not_found' });
        return true;
      }
      if (!endpointAllowed(principal, resolved.definition.id)) {
        await reply
          .code(403)
          .header('www-authenticate', 'Bearer error="insufficient_scope", scope="mcp"')
          .send({ error: 'insufficient_scope' });
        return true;
      }
      prepared.set(req, {
        principal,
        token: bearerToken(header(req.headers.authorization)),
        resolved,
        endpointPath: parsed,
        origin,
      });
      return false;
    };

    const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const prep = prepared.get(req);
      if (!prep) {
        await reply.code(500).send({ error: 'internal' });
        return;
      }
      let body: unknown;
      if (req.method === 'POST') {
        if (!isJsonContentType(header(req.headers['content-type']) ?? '')) {
          await reply
            .code(415)
            .send(rpcError(-32600, 'Unsupported Media Type: Content-Type must be application/json'));
          return;
        }
        try {
          const raw = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
          body = JSON.parse(raw.toString('utf8')) as unknown;
        } catch {
          await reply.code(400).send(rpcError(-32700, 'Parse error'));
          return;
        }
      }
      const pathname = (req.url.split('?')[0] ?? req.url).replace(/\/+$/, '') || '/';
      const meta = (body as { params?: { _meta?: unknown } } | undefined)?.params?._meta;
      const rc: BastionRequestContext = {
        principal: prep.principal,
        authInfo: {
          token: prep.token,
          clientId: prep.principal.clientId ?? '',
          scopes: [...prep.principal.scopes],
        },
        tokenHash: sha256Hex(prep.token),
        resolved: prep.resolved,
        endpointPath: prep.endpointPath,
        requestUrl: new URL(req.url, deps.baseUrl).toString(),
        path: pathname,
        ip: req.ip,
        origin: prep.origin,
        headers: req.headers,
        ...(body === undefined ? {} : { body }),
        ...(typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? { meta: meta as JsonObject } : {}),
      };
      // `request.raw.auth` is how the SDK receives the verified principal (`authInfo`).
      Object.assign(req.raw, { auth: rc.authInfo });
      reply.hijack();
      const exchange: Exchange = { req: req.raw, res: reply.raw, body, rc };
      await deps.track(() =>
        bastionRequestContext.run(rc, async () => {
          try {
            await dispatch(exchange, toWebRequest(req, deps.baseUrl));
          } catch (error) {
            deps.logger.error('mcp exchange failed', { error: String(error) });
            if (!reply.raw.headersSent) {
              const payload = JSON.stringify(rpcError(-32603, 'Internal error'));
              reply.raw.writeHead(500, { 'content-type': 'application/json' });
              reply.raw.end(payload);
            } else if (!reply.raw.writableEnded) {
              reply.raw.end();
            }
          }
        }),
      );
    };

    const dispatch = async (exchange: Exchange, web: Request): Promise<void> => {
      const method = exchange.req.method ?? 'GET';
      if (method !== 'POST') {
        // Session operations of the 2025 transport; the modern era has none.
        await deps.legacy.handle(exchange);
        return;
      }
      if (header(exchange.req.headers['mcp-method']) === 'subscriptions/listen') {
        await deps.listen.handle(exchange);
        return;
      }
      if (await isLegacyRequest(web, exchange.body)) {
        await deps.legacy.handle(exchange);
        return;
      }
      if (isDirectExchange(exchange)) {
        await deps.direct.handle(exchange);
        return;
      }
      await deps.modern.node(exchange.req as never, exchange.res as never, exchange.body);
    };

    for (const url of ['/mcp', '/mcp/e/:slug', '/mcp/i/:slug', '/mcp/c/:slug']) {
      scope.route({ method: ['GET', 'POST', 'DELETE'], url, handler });
    }
    // Everything else under /mcp is a 404 behind the same flood limit.
    scope.all('/mcp/*', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
  });
};

const sendAuthError = async (reply: FastifyReply, error: unknown, logger: Logger): Promise<void> => {
  if (error instanceof AuthenticationError) {
    await reply
      .code(401)
      .header('www-authenticate', error.wwwAuthenticate)
      .send({ error: 'invalid_token', error_description: error.message });
    return;
  }
  if (error instanceof InsufficientScopeError) {
    await reply
      .code(403)
      .header('www-authenticate', error.wwwAuthenticate)
      .send({ error: 'insufficient_scope', error_description: error.message });
    return;
  }
  if (isBastionError(error)) {
    const e: BastionError = error;
    await reply.code(e.httpStatus).send(rpcError(toRpcErrorBody(e).code, e.message));
    return;
  }
  logger.error('token verification failed unexpectedly', { error: String(error) });
  await reply.code(503).header('retry-after', '1').send({ error: 'unavailable' });
};
