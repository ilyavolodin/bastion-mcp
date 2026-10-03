/** Endpoints (7.1): the named sets of installations a client connects to, and their connection snippets. */
import { isValidSlug } from '@bastion-mcp/core/ids';
import {
  checkVersion,
  etagHeaders,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  problem,
  route,
} from '../../http';
import { ME_ID } from '../../seed';
import { getDb, nextId } from '../../state';
import { nowIso } from '../../util';
import { clientConfig, clientQuery } from './client-config';
import { data, validation, visibleInstallation } from './store';
import type { Endpoint } from './types';

const ME = ME_ID;

const endpointErrors = (
  input: {
    slug?: string | undefined;
    displayName?: string | undefined;
    installationIds?: string[] | undefined;
  },
  partial = false,
) => {
  const errors: { path: string; message: string }[] = [];
  if (!partial || input.slug !== undefined) {
    if (!input.slug || input.slug.length < 2 || input.slug.length > 40) {
      errors.push({ path: '/slug', message: 'Too small: expected string to have >=2 characters' });
    } else if (!isValidSlug(input.slug)) {
      errors.push({ path: '/slug', message: 'use lowercase letters, digits and dashes' });
    }
  }
  if ((!partial || input.displayName !== undefined) && !input.displayName?.trim()) {
    errors.push({
      path: '/displayName',
      message: 'Too small: expected string to have >=1 characters',
    });
  }
  for (const id of input.installationIds ?? []) {
    if (!visibleInstallation(id)) {
      errors.push({ path: '/installationIds', message: `unknown installation ${id}` });
    }
  }
  return errors;
};

export const endpointHandlers = [
  route.get('/endpoints', ({ url }) => HttpResponse.json(pageOf(data().endpoints, url))),

  route.post('/endpoints', async ({ body }) => {
    const input = await body();
    const errors = endpointErrors(input);
    if (errors.length) return validation(errors);
    if (data().endpoints.some((e) => e.slug === input.slug)) {
      return problem(409, 'slug_collision', 'You already have an endpoint with this slug');
    }
    const row: Endpoint = {
      id: nextId('e'),
      ownerType: 'user',
      ownerId: ME,
      slug: input.slug,
      displayName: input.displayName,
      installationIds: input.installationIds ?? [],
      prefixMode: input.prefixMode ?? 'always',
      instructions: input.instructions ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data().endpoints.push(row);
    return HttpResponse.json(row, { status: 201, headers: etagHeaders(row.updatedAt) });
  }),

  route.get('/endpoints/{id}', ({ params }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    return row
      ? HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) })
      : notFound('Endpoint');
  }),

  route.patch('/endpoints/{id}', async ({ params, request, body }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    if (!row) return notFound('Endpoint');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    const patch = await body();
    if (Object.keys(patch).length === 0) {
      return validation([{ path: '/', message: 'at least one field is required' }]);
    }
    const errors = endpointErrors(patch, true);
    if (errors.length) return validation(errors);
    if (patch.slug && data().endpoints.some((e) => e.id !== row.id && e.slug === patch.slug)) {
      return problem(409, 'slug_collision', 'You already have an endpoint with this slug');
    }
    Object.assign(row, patch, { updatedAt: nowIso() });
    return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
  }),

  route.delete('/endpoints/{id}', ({ params, request }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    if (!row) return notFound('Endpoint');
    const stale = checkVersion(request, row);
    if (stale) return stale;
    data().endpoints = data().endpoints.filter((e) => e.id !== row.id);
    return noContent();
  }),

  route.get('/endpoints/{id}/client-config', ({ params, url }) => {
    const row = data().endpoints.find((e) => e.id === params.id);
    if (!row) return notFound('Endpoint');
    const q = clientQuery(url);
    if (!q) return validation([{ path: '/client', message: 'Invalid option' }]);
    return HttpResponse.json(
      clientConfig(
        q.client,
        `${getDb().me.org.baseUrl}/mcp/e/${row.slug}`,
        `bastion-${row.slug}`,
        q.auth,
      ),
    );
  }),

  route.get('/client-config', ({ url }) => {
    const q = clientQuery(url);
    if (!q) return validation([{ path: '/client', message: 'Invalid option' }]);
    return HttpResponse.json(
      clientConfig(q.client, `${getDb().me.org.baseUrl}/mcp`, 'bastion-default', q.auth),
    );
  }),
];
