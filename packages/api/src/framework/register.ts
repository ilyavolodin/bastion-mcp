import { AuthenticationError, InsufficientScopeError, type Principal } from '@bastion-mcp/auth';
import { REDIS_CHANNELS } from '@bastion-mcp/core';
import type {
  ManagementAction,
  PolicyEngine,
  PrincipalData,
  ResourceData,
} from '@bastion-mcp/policy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenApiError } from '../errors';
import type { ApiDeps } from '../ports';
import { authenticate, toPolicyPrincipal } from './auth';
import { checkPrecondition, etagOf } from './conventions';
import { fingerprintOf, IdempotencyStore, validateKey } from './idempotency';
import { makeProblem, toProblem } from './problem';
import { type AuthzInput, type MutationTx, type RouteDefinition, RouteReply } from './route';
import { assertRouteDeclarations, ruleOf } from './route-table';

type RequestState = {
  principal: Principal;
  subject: PrincipalData;
  engine: PolicyEngine;
};

const states = new WeakMap<FastifyRequest, RequestState>();

const headerOf = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** `/catalog/{id}` -> `/catalog/:id` (Fastify syntax); `{path}` params carry encoded slashes. */
export const toFastifyUrl = (url: string): string => url.replace(/\{([^}]+)\}/g, ':$1');

const rawInput = (req: FastifyRequest, state: RequestState, deps: ApiDeps): AuthzInput => ({
  params: (req.params ?? {}) as Record<string, string>,
  query: (req.query ?? {}) as Record<string, string | undefined>,
  body: req.body,
  principal: state.principal,
  subject: state.subject,
  deps,
});

const decide = (
  engine: PolicyEngine,
  subject: PrincipalData,
  action: ManagementAction,
  resource: ResourceData,
): boolean => engine.authorize({ principal: subject, action, resource }).decision === 'allow';

/** Authorizes before any data is touched by the handler (10, 17.1). */
const authorizeRoute = async (
  def: RouteDefinition,
  input: AuthzInput,
  state: RequestState,
): Promise<void> => {
  if (def.authz.kind !== 'resource') return;
  const choice = await def.authz.select(input);
  const rule = ruleOf(choice.rule);
  if (!rule || rule.action === null) return;
  if (!decide(state.engine, state.subject, rule.action, choice.resource)) {
    throw new ForbiddenApiError(`not allowed to ${rule.action}`, {
      action: rule.action,
      resource: choice.resource.type,
    });
  }
};

const isReply = (value: unknown): value is RouteReply<unknown> => value instanceof RouteReply;

const encodeSse = (event: { event: string; data: unknown; id?: string | undefined }): string =>
  `${event.id ? `id: ${event.id}\n` : ''}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

const sendProblem = (reply: FastifyReply, req: FastifyRequest, error: unknown): FastifyReply => {
  const problem = toProblem(error, req.url.split('?')[0]);
  if (error instanceof AuthenticationError || error instanceof InsufficientScopeError) {
    reply.header('www-authenticate', error.wwwAuthenticate);
  }
  return reply.code(problem.status).type('application/problem+json').send(JSON.stringify(problem));
};

/** Installs the problem+json error and not-found handlers on the API scope (17.1). */
export const installProblemHandlers = (api: FastifyInstance): void => {
  api.setErrorHandler((error, req, reply) => {
    if (toProblem(error).status >= 500) {
      req.log.error({ err: error }, 'unhandled error in the control-plane API');
    }
    return sendProblem(reply, req, error);
  });
  api.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .type('application/problem+json')
      .send(
        JSON.stringify(
          makeProblem(404, 'not_found', 'route not found', {
            instance: req.url.split('?')[0] ?? '',
          }),
        ),
      );
  });
};

/** Registers route definitions on the API scope. */
export const registerRoutes = (
  api: FastifyInstance,
  deps: ApiDeps,
  routes: readonly RouteDefinition[],
): void => {
  assertRouteDeclarations(routes);
  const idempotency = new IdempotencyStore(deps.redis);

  for (const def of routes) {
    api.route({
      method: def.method,
      url: toFastifyUrl(def.url),
      ...(def.bodyLimit === undefined ? {} : { bodyLimit: def.bodyLimit }),
      schema: {
        tags: [def.tag],
        summary: def.summary,
        ...(def.schema.params ? { params: def.schema.params } : {}),
        ...(def.schema.query ? { querystring: def.schema.query } : {}),
        ...(def.schema.body ? { body: def.schema.body } : {}),
        ...(def.schema.response && !def.stream
          ? { response: { [def.status]: def.schema.response } }
          : {}),
        security: [{ bearer: [] }, { session: [] }],
      },
      preValidation: async (req) => {
        const principal = await authenticate(req, deps);
        const subject = toPolicyPrincipal(principal);
        const engine = await deps.policy.engine();
        const state: RequestState = { principal, subject, engine };
        states.set(req, state);
        await authorizeRoute(def, rawInput(req, state, deps), state);
      },
      handler: async (req, reply) => {
        const state = states.get(req);
        if (!state) throw new ForbiddenApiError('request was not authenticated');
        return run(def, deps, idempotency, state, req, reply);
      },
    });
  }
};

const run = async (
  def: RouteDefinition,
  deps: ApiDeps,
  idempotency: IdempotencyStore,
  state: RequestState,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const abort = new AbortController();
  req.raw.on('close', () => abort.abort());
  const base = {
    req,
    deps,
    principal: state.principal,
    subject: state.subject,
    engine: state.engine,
    params: req.params,
    query: req.query,
    body: req.body,
    signal: abort.signal,
    can: (action: ManagementAction, resource: ResourceData) =>
      decide(state.engine, state.subject, action, resource),
    authorize: (action: ManagementAction, resource: ResourceData) => {
      if (!decide(state.engine, state.subject, action, resource)) {
        throw new ForbiddenApiError(`not allowed to ${action}`, { action });
      }
    },
  };

  if (def.stream) return stream(def, base, state, req, reply, deps, abort);

  const key = def.method === 'POST' ? headerOf(req, 'idempotency-key') : undefined;
  const fingerprint = key ? fingerprintOf(def.method, req.url, req.body) : '';
  if (key) {
    validateKey(key);
    const replay = await idempotency.lookup(state.principal.id, key, fingerprint);
    if (replay) {
      for (const [name, value] of Object.entries(replay.headers)) reply.header(name, value);
      return reply
        .code(replay.status)
        .header('idempotency-replayed', 'true')
        .type('application/json')
        .send(replay.body);
    }
  }

  if (def.version) {
    const current = await def.version({
      ...rawInput(req, state, deps),
      parsedParams: req.params,
    });
    checkPrecondition(current, headerOf(req, 'if-match'));
  }

  let result: unknown;
  if (def.mutates) {
    result = await deps.uow.run(async (tx) => {
      let audits = 0;
      const actor = {
        actorType: state.principal.type,
        actorId: state.principal.id,
        ip: req.ip,
        userAgent: headerOf(req, 'user-agent') ?? null,
        requestId: String(req.id),
      } as const;
      const mtx: MutationTx = {
        store: tx.store,
        audit: async (event) => {
          audits += 1;
          await tx.audit({ ...event, ...actor });
        },
        afterCommit: (hook) => tx.afterCommit(hook),
        configChanged: (topic) =>
          tx.afterCommit(() =>
            deps.publisher.publish(REDIS_CHANNELS.config, JSON.stringify({ topic })),
          ),
        emit: (event) => tx.afterCommit(() => deps.events.publish(event)),
      };
      const out = await (def.handler as (ctx: unknown) => unknown)({ ...base, tx: mtx });
      if (audits === 0) {
        throw new Error(`mutating route ${def.method} ${def.url} wrote no audit event`);
      }
      return out;
    });
  } else {
    result = await (def.handler as (ctx: unknown) => unknown)(base);
  }

  const wrapped = isReply(result) ? result : new RouteReply(result);
  const status = wrapped.options.status ?? def.status;
  for (const [name, value] of Object.entries(wrapped.options.headers ?? {}))
    reply.header(name, value);
  if (wrapped.options.raw) return reply.code(status).send(String(wrapped.body));
  if (status === 204 || !def.schema.response) return reply.code(204).send();

  const parsed: unknown = def.schema.response.parse(wrapped.body);
  const version = (parsed as { updatedAt?: unknown } | null)?.updatedAt;
  if (typeof version === 'string') reply.header('etag', etagOf(version));
  const payload = JSON.stringify(parsed);
  if (key && status >= 200 && status < 300) {
    const headers: Record<string, string> = {};
    if (typeof version === 'string') headers.etag = etagOf(version);
    await idempotency.save(state.principal.id, key, {
      fingerprint,
      status,
      body: payload,
      headers,
    });
  }
  return reply.code(status).type('application/json').send(payload);
};

const stream = async (
  def: RouteDefinition,
  base: Record<string, unknown>,
  _state: RequestState,
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ApiDeps,
  abort: AbortController,
): Promise<FastifyReply> => {
  const source = (await (def.handler as (ctx: unknown) => unknown)(
    base,
  )) as import('./route').SseSource;
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  let closed = false;
  const timers: NodeJS.Timeout[] = [];
  let cleanup: () => void = () => {};
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearInterval(t);
    cleanup();
    if (!raw.writableEnded) raw.end();
  };
  const emit = (event: { event: string; data: unknown; id?: string }): void => {
    if (!closed && !raw.writableEnded) raw.write(encodeSse(event));
  };
  for (const event of source.initial ?? []) emit(event);
  // Timers first: a source may call `end()` while subscribing, which must clear them.
  timers.push(
    setInterval(() => {
      if (!closed) raw.write(': ping\n\n');
    }, deps.config.sseHeartbeatMs ?? 15_000),
  );
  const max = setTimeout(end, (deps.config.sseMaxSeconds ?? 3600) * 1000);
  timers.push(max as unknown as NodeJS.Timeout);
  cleanup = source.subscribe(emit, end);
  if (closed) cleanup();
  req.raw.on('close', () => {
    abort.abort();
    clearTimeout(max);
    end();
  });
  return reply;
};
