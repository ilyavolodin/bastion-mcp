import type { Principal } from '@bastion-mcp/auth';
import type {
  ManagementAction,
  PolicyEngine,
  PrincipalData,
  ResourceData,
} from '@bastion-mcp/policy';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ApiDeps } from '../ports';
import type { ApiEvent } from '../ports/events';
import type { AuditDescriptor, Tx } from '../ports/uow';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Raw (unvalidated) request view handed to authorization resolvers: authorization runs before validation. */
export type AuthzInput = {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  principal: Principal;
  subject: PrincipalData;
  deps: ApiDeps;
};

export type ResourceChoice = { rule: string; resource: ResourceData };

/**
 * Every route declares its Cedar action (17.1, 10): `rule` ids come from the policy package's
 * `ROUTE_ACTIONS` table. `select` picks the rule and resource; `filter` routes authorize each item inside
 * the service (lists), `self` routes touch only the caller's own data.
 */
export type Authz =
  | {
      kind: 'resource';
      rules: readonly string[];
      select: (input: AuthzInput) => Promise<ResourceChoice> | ResourceChoice;
    }
  | { kind: 'filter'; rule: string }
  | { kind: 'self' };

export const authz = {
  /** One rule, one resource. */
  on: (
    rule: string,
    resource: (input: AuthzInput) => Promise<ResourceData> | ResourceData,
  ): Authz => ({
    kind: 'resource',
    rules: [rule],
    select: async (input) => ({ rule, resource: await resource(input) }),
  }),
  /** Several rules for one route (for example org-wide versus team-scoped). */
  oneOf: (
    rules: readonly string[],
    select: (input: AuthzInput) => Promise<ResourceChoice> | ResourceChoice,
  ): Authz => ({ kind: 'resource', rules, select }),
  /** Authorizes per item inside the handler through `ctx.can`. */
  filter: (rule: string): Authz => ({ kind: 'filter', rule }),
  /** Authenticated principal acting on its own data. */
  self: (): Authz => ({ kind: 'self' }),
};

export type OrgResource = { type: 'Org' };
export const ORG: OrgResource = { type: 'Org' };

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export type RouteSchema = {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** The success body. */
  response: z.ZodType;
};

export type BaseContext<S extends RouteSchema> = {
  req: FastifyRequest;
  deps: ApiDeps;
  principal: Principal;
  /** The caller as the policy engine sees it. */
  subject: PrincipalData;
  engine: PolicyEngine;
  params: Out<S['params']>;
  query: Out<S['query']>;
  body: Out<S['body']>;
  /** True when Cedar allows `action` on `resource` for the caller. */
  can(action: ManagementAction, resource: ResourceData): boolean;
  /** Throws a 403 problem unless Cedar allows it. */
  authorize(action: ManagementAction, resource: ResourceData): void;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
};

/** The transaction a mutating route runs in; its audit event commits or rolls back with the change. */
export type MutationTx = {
  store: Tx['store'];
  /** Required: a mutating route that writes no audit event fails (17.1). */
  audit(event: AuditDescriptor): Promise<void>;
  afterCommit(hook: () => Promise<void> | void): void;
  /** Publishes `bastion:config` with `topic` after commit so workers refresh (4.3, 16.3). */
  configChanged(topic: string): void;
  /** Publishes an SSE event after commit. */
  emit(event: ApiEvent): void;
};

export type MutationContext<S extends RouteSchema> = BaseContext<S> & { tx: MutationTx };

/** Wraps a body with a status or headers other than the route default (for example `202`). */
export class RouteReply<R> {
  constructor(
    readonly body: R,
    readonly options: {
      status?: number;
      headers?: Record<string, string>;
      /** Send `body` (a string) as is with the `content-type` header given; skips JSON and the schema. */
      raw?: true;
    } = {},
  ) {}
}
export type RouteResult<S extends RouteSchema> =
  | z.input<S['response']>
  | RouteReply<z.input<S['response']>>;

type Common<S extends RouteSchema> = {
  url: string;
  tag: string;
  summary: string;
  schema: S;
  authz: Authz;
  /** Success status (default 200; 201 for creates, 204 for deletes). */
  status?: 200 | 201 | 202 | 204;
  /** Request body limit in bytes (Fastify default 1 MiB); raise it for uploads. */
  bodyLimit?: number;
};

/** Loads the current version (ETag) of the addressed resource; `null` when it does not exist. */
export type VersionLoader<S extends RouteSchema> = (
  input: AuthzInput & { parsedParams: Out<S['params']> },
) => Promise<string | null>;

export type ReadRouteDef<S extends RouteSchema> = Common<S> & {
  method: 'GET' | 'POST';
  /** A POST that changes nothing (preview, validate, test): no transaction and no audit event. */
  readOnly?: true;
  handler: (ctx: BaseContext<S>) => Promise<RouteResult<S>> | RouteResult<S>;
};

export type MutatingRouteDef<S extends RouteSchema> =
  | (Common<S> & {
      method: 'POST';
      readOnly?: false;
      handler: (ctx: MutationContext<S>) => Promise<RouteResult<S>> | RouteResult<S>;
    })
  | (Common<S> & {
      method: 'PATCH' | 'PUT' | 'DELETE';
      /** Required: `If-Match` is checked against it (412 on mismatch, 428 when missing). */
      version: VersionLoader<S>;
      handler: (ctx: MutationContext<S>) => Promise<RouteResult<S>> | RouteResult<S>;
    });

export type SseSource = {
  /** Events sent right away. */
  initial?: Array<{ event: string; data: unknown; id?: string }>;
  /** Called once the stream is open; returns the cleanup. Call `end()` to finish the stream. */
  subscribe(
    emit: (event: { event: string; data: unknown; id?: string }) => void,
    end: () => void,
  ): () => void;
};

export type StreamRouteDef<S extends RouteSchema> = Omit<Common<S>, 'schema'> & {
  method: 'GET';
  stream: true;
  schema: Omit<S, 'response'> & { response?: undefined };
  handler: (ctx: BaseContext<S & { response: z.ZodType }>) => Promise<SseSource> | SseSource;
};

/** What the registrar stores; the typed constructors below erase the generics once. */
export type RouteDefinition = {
  method: HttpMethod;
  url: string;
  tag: string;
  summary: string;
  schema: {
    params?: z.ZodType | undefined;
    query?: z.ZodType | undefined;
    body?: z.ZodType | undefined;
    response?: z.ZodType | undefined;
  };
  authz: Authz;
  status: number;
  mutates: boolean;
  stream: boolean;
  bodyLimit?: number | undefined;
  version?: ((input: AuthzInput & { parsedParams: unknown }) => Promise<string | null>) | undefined;
  /** Erased once by the typed constructors; the registrar supplies the context they declared. */
  handler: (ctx: never) => unknown;
};

const defaultStatus = (method: HttpMethod): number => (method === 'POST' ? 201 : 200);

/**
 * Declares a read route (GET, or a POST that changes nothing). `authz` is a required property: omitting it
 * does not compile, and `registerApi` refuses to start when a definition lacks one (17.1).
 */
export const defineRoute = <S extends RouteSchema>(def: ReadRouteDef<S>): RouteDefinition => ({
  method: def.method,
  url: def.url,
  tag: def.tag,
  summary: def.summary,
  schema: def.schema,
  authz: def.authz,
  status: def.status ?? 200,
  mutates: false,
  stream: false,
  handler: def.handler,
});

/** Declares a mutating route: runs in a transaction, must write an audit event, honors `If-Match`. */
export const defineMutation = <S extends RouteSchema>(
  def: MutatingRouteDef<S>,
): RouteDefinition => ({
  method: def.method,
  url: def.url,
  tag: def.tag,
  summary: def.summary,
  schema: def.schema,
  authz: def.authz,
  status: def.status ?? defaultStatus(def.method),
  mutates: true,
  stream: false,
  bodyLimit: def.bodyLimit,
  version: 'version' in def ? (def.version as RouteDefinition['version']) : undefined,
  handler: def.handler,
});

/** Declares a Server-Sent Events route (`text/event-stream`). */
export const defineStream = <S extends Omit<RouteSchema, 'response'>>(
  def: Omit<StreamRouteDef<S & { response: z.ZodType }>, 'schema' | 'stream' | 'method'> & {
    schema: S;
  },
): RouteDefinition => ({
  method: 'GET',
  url: def.url,
  tag: def.tag,
  summary: def.summary,
  schema: def.schema,
  authz: def.authz,
  status: 200,
  mutates: false,
  stream: true,
  handler: def.handler,
});

export type RouteRegistrar = (routes: readonly RouteDefinition[]) => void;
