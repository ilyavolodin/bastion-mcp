/** Catalog entries and secrets; `catalogHandlers` is the whole domain (entries, versions, files, auto-install). */
import { slugify } from '@bastion-mcp/core/ids';
import type { HttpHandler } from 'msw';
import type { Body } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  forbidden,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  problem,
  route,
} from '../../http';
import { isRole } from '../../roles';
import { getDb, nextId } from '../../state';
import { nowIso } from '../../util';
import { autoInstallHandlers } from './auto-install';
import { fileHandlers } from './files';
import { data, entryOf, entryRoute, putSecret, secretKey, validation } from './store';
import type { Entry } from './types';
import { versionHandlers } from './versions';

type EntryCreate = Body<'post', '/catalog'>;

export const catalogHandlers: HttpHandler[] = [
  route.get(
    '/catalog',
    ({ query, url }) => {
      const text = (query.q ?? '').toLowerCase();
      const rows = data().entries.filter(
        (e) =>
          (!query.kind || e.kind === query.kind) &&
          (!query.status || e.status === query.status) &&
          (!query.ownerTeamId || e.ownerTeamId === query.ownerTeamId) &&
          (!text || `${e.displayName} ${e.slug}`.toLowerCase().includes(text)),
      );
      return HttpResponse.json(pageOf(rows, url));
    },
    { allow: 'readConfig' },
  ),

  route.post(
    '/catalog',
    async ({ body }) => {
      const input: EntryCreate = await body();
      const errors: { path: string; message: string }[] = [];
      if (!input.displayName?.trim()) errors.push({ path: '/displayName', message: 'Required' });
      if (!input.slug) errors.push({ path: '/slug', message: 'Required' });
      if (input.slug && (input.slug.length > 63 || slugify(input.slug, 63) !== input.slug))
        errors.push({
          path: '/slug',
          message: 'Use lowercase letters, digits and dashes (up to 63)',
        });
      if (errors.length) return validation(errors);
      if (data().entries.some((e) => e.slug === input.slug))
        return problem(409, 'conflict', 'A catalog entry with this slug already exists');
      const at = nowIso();
      const entry: Entry = {
        id: nextId('c'),
        slug: input.slug,
        kind: input.kind ?? 'mcp_server',
        displayName: input.displayName.trim(),
        description: input.description ?? '',
        tags: input.tags ?? [],
        ownerTeamId: input.ownerTeamId ?? null,
        visibility: {
          org: input.visibility?.org ?? false,
          teamIds: input.visibility?.teamIds ?? [],
          userIds: input.visibility?.userIds ?? [],
        },
        status: 'draft',
        risk: input.risk ?? 'medium',
        source: { kind: 'manual' },
        currentVersionId: null,
        autoUpgrade: input.autoUpgrade ?? true,
        userOverrides: input.userOverrides ?? 'cosmetic',
        onDrift: input.onDrift ?? 'hideChanged',
        createdBy: getDb().me.id,
        createdAt: at,
        updatedAt: at,
      };
      data().entries.unshift(entry);
      return HttpResponse.json(entry, { status: 201, headers: etagHeaders(entry.updatedAt) });
    },
    { allow: 'manage' },
  ),

  route.get(
    '/catalog/{id}',
    ({ params }) => {
      const e = entryOf(params.id);
      return e
        ? HttpResponse.json(e, { headers: etagHeaders(e.updatedAt) })
        : notFound('Catalog entry');
    },
    { allow: 'readConfig' },
  ),

  entryRoute.delete(
    '/catalog/{id}',
    ({ entry: e, request }) => {
      const stale = checkVersion(request, e);
      if (stale) return stale;
      // Real installations block a delete (hidden `origin: 'test'` ones do not count and go with the entry).
      const servers = getDb().data.servers;
      const real = servers.installations.filter(
        (i) => i.catalogEntryId === e.id && i.origin !== 'test',
      );
      if (real.length > 0) {
        return problem(
          409,
          'entry_in_use',
          'Conflict',
          `${real.length} installation${real.length === 1 ? ' uses' : 's use'} this entry, so it cannot be deleted. Deprecate it to hide it from the Store, or remove the installations first.`,
        );
      }
      servers.installations = servers.installations.filter((i) => i.catalogEntryId !== e.id);
      data().entries = data().entries.filter((x) => x.id !== e.id);
      data().versions = data().versions.filter((v) => v.entryId !== e.id);
      return noContent();
    },
    { allow: 'manage' },
  ),

  // Secrets of the editor (9.5, 22.3): the shared secret of a server is written by an Admin; values are never kept.
  route.get('/secrets', ({ query }) => {
    if (query.scope === 'org' && !isRole('admin')) return forbidden();
    const items = Object.values(data().secrets)
      .filter((x) => x.scope === query.scope)
      .map((x) => ({
        id: `${x.scope}/${x.ownerId ?? ''}/${x.name}`,
        scope: x.scope,
        ownerId: x.ownerId,
        name: x.name,
        version: x.version,
        createdAt: x.updatedAt,
        updatedAt: x.updatedAt,
      }));
    return HttpResponse.json({ items });
  }),

  route.put(
    '/secrets/org/{ownerId}/{name}',
    async ({ request, params, body, waiveVersion }) => {
      const existing = data().secrets[secretKey('org', null, params.name)];
      if (!existing) waiveVersion();
      const stale = existing ? checkVersion(request, existing) : null;
      if (stale) return stale;
      const { value } = await body();
      if (!value) return validation([{ path: '/value', message: 'Required' }]);
      return HttpResponse.json(putSecret('org', null, params.name));
    },
    { allow: 'admin' },
  ),

  route.put('/secrets/user/{ownerId}/{name}', async ({ request, params, body, waiveVersion }) => {
    const existing = data().secrets[secretKey('user', params.ownerId, params.name)];
    if (!existing) waiveVersion();
    const stale = existing ? checkVersion(request, existing) : null;
    if (stale) return stale;
    const { value } = await body();
    if (!value) return validation([{ path: '/value', message: 'Required' }]);
    return HttpResponse.json(putSecret('user', params.ownerId, params.name));
  }),

  entryRoute.patch(
    '/catalog/{id}',
    async ({ entry: e, request, body }) => {
      const stale = checkVersion(request, e);
      if (stale) return stale;
      const patch = await body();
      if (Object.keys(patch).length === 0)
        return validation([{ path: '/', message: 'at least one field is required' }]);
      if (patch.displayName !== undefined && !patch.displayName.trim())
        return validation([{ path: '/displayName', message: 'Required' }]);
      const { status, visibility, ...rest } = patch;
      if (
        (status === 'deprecated' && e.status !== 'published') ||
        (status === 'archived' && e.status !== 'published' && e.status !== 'deprecated')
      ) {
        return problem(
          409,
          'invalid_status',
          'Conflict',
          `a ${e.status} entry cannot be ${status}; only published or deprecated entries can change status`,
        );
      }
      Object.assign(e, rest, status ? { status } : {}, {
        ...(visibility
          ? {
              visibility: {
                org: visibility.org ?? false,
                teamIds: visibility.teamIds ?? [],
                userIds: visibility.userIds ?? [],
              },
            }
          : {}),
        updatedAt: nowIso(),
      });
      return HttpResponse.json(e, { headers: etagHeaders(e.updatedAt) });
    },
    { allow: 'manage' },
  ),

  ...versionHandlers,
  ...fileHandlers,
  ...autoInstallHandlers,
];
