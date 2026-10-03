/** What the catalog handlers share: the db slice, lookups and secrets. */
import type { Method, PathKey, Res } from '@/api/schema';
import { type Answer, notFound, type RouteInfo, type RouteOptions, route } from '../../http';
import { getDb } from '../../state';
import { nowIso, validationFailed } from '../../util';
import type { Entry, Version } from './types';

export const data = () => getDb().data.catalog;

export const entryOf = (id: string) => data().entries.find((e) => e.id === id);
export const versionOf = (entryId: string, versionId: string) =>
  data().versions.find((v) => v.entryId === entryId && v.id === versionId);

/** The version installations get: the current one, else the newest published (a seeded draft entry: its only version). */
export const currentVersion = (e: NonNullable<ReturnType<typeof entryOf>>) =>
  (e.currentVersionId ? versionOf(e.id, String(e.currentVersionId)) : undefined) ??
  data().versions.findLast((v) => v.entryId === e.id && v.status === 'published') ??
  data().versions.findLast((v) => v.entryId === e.id);

export const validation = validationFailed;

export const secretKey = (scope: 'org' | 'user', ownerId: string | null, name: string) =>
  `${scope}/${ownerId ?? ''}/${name}`;

export const putSecret = (scope: 'org' | 'user', ownerId: string | null, name: string) => {
  const key = secretKey(scope, ownerId, name);
  const previous = data().secrets[key];
  const row = { scope, ownerId, name, version: (previous?.version ?? 0) + 1, updatedAt: nowIso() };
  data().secrets[key] = row;
  return {
    id: key,
    scope,
    ownerId,
    name,
    version: row.version,
    createdAt: previous?.updatedAt ?? row.updatedAt,
    updatedAt: row.updatedAt,
  };
};

type Resolve<M extends Method, K extends PathKey<M>, Extra> = (
  info: RouteInfo<M, K> & Extra,
) => Answer<Res<M, K>> | Promise<Answer<Res<M, K>>>;

/**
 * `entryRoute.patch('/catalog/{id}', ({ entry }) => ...)`: a route of one catalog entry. The entry is looked up
 * from `{id}` and the handler runs only when it exists; otherwise the answer is the 404.
 */
export const entryRoute = Object.fromEntries(
  (['get', 'post', 'put', 'patch', 'delete'] as const).map((method) => [
    method,
    (key: never, resolve: never, options?: RouteOptions) =>
      (route[method] as (k: never, r: never, o?: RouteOptions) => unknown)(
        key,
        ((info: RouteInfo<Method, never> & { params: { id: string } }) => {
          const entry = entryOf(info.params.id);
          return entry
            ? (resolve as (i: unknown) => unknown)({ ...info, entry })
            : notFound('Catalog entry');
        }) as never,
        options,
      ),
  ]),
) as unknown as {
  [M in Method]: <K extends PathKey<M>>(
    key: K,
    resolve: Resolve<M, K, { entry: Entry }>,
    options?: RouteOptions,
  ) => ReturnType<(typeof route)[M]>;
};

/** The same for a route of one version of an entry (`{id}` and `{vid}`): the handler gets `entry` and `version`. */
export const versionRoute = Object.fromEntries(
  (['get', 'post', 'put', 'patch', 'delete'] as const).map((method) => [
    method,
    (key: never, resolve: never, options?: RouteOptions) =>
      (route[method] as (k: never, r: never, o?: RouteOptions) => unknown)(
        key,
        ((info: RouteInfo<Method, never> & { params: { id: string; vid: string } }) => {
          const entry = entryOf(info.params.id);
          const version = versionOf(info.params.id, info.params.vid);
          return entry && version
            ? (resolve as (i: unknown) => unknown)({ ...info, entry, version })
            : notFound('Version');
        }) as never,
        options,
      ),
  ]),
) as unknown as {
  [M in Method]: <K extends PathKey<M>>(
    key: K,
    resolve: Resolve<M, K, { entry: Entry; version: Version }>,
    options?: RouteOptions,
  ) => ReturnType<(typeof route)[M]>;
};
