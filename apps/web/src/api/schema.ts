/**
 * Types of the control-plane API, all derived from the generated OpenAPI types of `@bastion-mcp/api-client`.
 * Nothing in this file (or in the rest of `src/api`) restates a request or response body by hand: use
 * `Schemas['Team']` for a named schema, or `Body<'post', '/teams'>` / `Res<'get', '/teams'>` /
 * `Query<'get', '/calls'>` for what one operation takes and returns.
 */
import type { components, PathsWith, paths } from '@bastion-mcp/api-client';

export type Schemas = components['schemas'];
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Operation paths of the OpenAPI document that define method `M`, as written there (`/teams/{id}`). */
export type PathKey<M extends Method> = Extract<PathsWith<M>, string>;

type Fill<P extends string> = P extends `${infer A}{${string}}${infer B}`
  ? `${A}${string}${Fill<B>}`
  : P;

type Candidates<M extends Method, P extends string> = {
  [K in PathKey<M>]: P extends Fill<K> ? K : never;
}[PathKey<M>];

/**
 * The operation path (`/teams/{id}`) a concrete path (`/teams/abc`, or a template literal such as
 * `/teams/${string}`) belongs to. A path parameter may stand for any text, so `/catalog/${string}/versions` also
 * fits `/catalog/{id}`; the most specific operation wins.
 */
export type KeyOf<M extends Method, P extends string> = {
  [K in Candidates<M, P>]: [
    Exclude<Candidates<M, P>, K> extends infer O
      ? O extends string
        ? [Fill<O>] extends [Fill<K>]
          ? [Fill<K>] extends [Fill<O>]
            ? never
            : true
          : never
        : never
      : never,
  ] extends [never]
    ? K
    : never;
}[Candidates<M, P>];

type Op<M extends Method, K extends PathKey<M>> = K extends keyof paths
  ? paths[K] extends Record<M, infer O>
    ? O
    : never
  : never;

/** The JSON request body of an operation (`never` when it takes none). */
export type Body<M extends Method, K extends PathKey<M>> =
  Op<M, K> extends { requestBody?: infer R }
    ? Exclude<R, undefined> extends { content: { 'application/json': infer B } }
      ? B
      : never
    : never;

/** The query string parameters of an operation (`never` when it takes none). */
export type Query<M extends Method, K extends PathKey<M>> =
  Op<M, K> extends {
    parameters: { query?: infer Q };
  }
    ? Exclude<Q, undefined>
    : never;

type SuccessStatus = 200 | 201 | 202 | 204;

/** The JSON body of an operation's success response (`undefined` for 204, `unknown` for streams). */
export type Res<M extends Method, K extends PathKey<M>> =
  Op<M, K> extends { responses: infer R }
    ? {
        [S in keyof R & SuccessStatus]: R[S] extends { content: { 'application/json': infer B } }
          ? B
          : undefined;
      }[keyof R & SuccessStatus]
    : never;

/** The element type of a `{ items: T[] }` page. */
export type ItemOf<T> = T extends { items: (infer I)[] } ? I : never;

/** `Res<'get', '/teams'>` for a concrete path. */
export type ResOf<M extends Method, P extends string> = Res<M, KeyOf<M, P> & PathKey<M>>;
export type BodyOf<M extends Method, P extends string> = Body<M, KeyOf<M, P> & PathKey<M>>;
export type QueryOf<M extends Method, P extends string> = Query<M, KeyOf<M, P> & PathKey<M>>;

// --- closed sets, from the schemas ------------------------------------------------------------------------------

export type OrgRole = Schemas['User']['orgRole'];
export type TeamRole = Schemas['TeamMember']['role'];
export type InstallationStatus = Schemas['Installation']['status'];
export type CatalogKind = Schemas['CatalogEntry']['kind'];
export type CatalogStatus = Schemas['CatalogEntry']['status'];
export type RiskLevel = Schemas['CatalogEntry']['risk'];
export type CallOutcome = Schemas['CallRecord']['outcome'];
export type PolicyEffect = Schemas['PolicyRule']['effect'];
export type DriftPolicy = Schemas['CatalogEntry']['onDrift'];
export type MarketplaceItemPolicy = Schemas['MarketplaceItem']['policy'];
