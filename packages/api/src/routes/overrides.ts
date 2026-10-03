import {
  authz,
  defineMutation,
  defineRoute,
  type RouteDefinition,
  RouteReply,
} from '../framework/route';
import { idParams } from '../schemas/common';
import {
  catalogVersionParams,
  overridesDocSchema,
  overridesViewSchema,
  previewBodySchema,
  previewResultSchema,
} from '../schemas/installations';
import {
  catalogOverridesVersion,
  entryOverridesVersion,
  getCatalogOverrides,
  getEntryOverrides,
  getInstallationOverrides,
  preview,
  putCatalogOverrides,
  putEntryOverrides,
  putInstallationOverrides,
} from '../services/overrides';
import { onCatalogEntry, onInstallation } from './installation-authz';
import { versionOf } from './shared';

const OVERRIDES = 'Overrides';

export const overridesRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/versions/{vid}/overrides',
    tag: OVERRIDES,
    summary: 'Catalog-layer overrides of a version',
    schema: { params: catalogVersionParams, response: overridesViewSchema },
    authz: onCatalogEntry('overrides.catalog'),
    handler: (ctx) => getCatalogOverrides(ctx, ctx.params.id, ctx.params.vid),
  }),
  defineMutation({
    method: 'PUT',
    url: '/catalog/{id}/versions/{vid}/overrides',
    tag: OVERRIDES,
    summary: 'Replace the catalog-layer overrides of a draft version',
    schema: {
      params: catalogVersionParams,
      body: overridesDocSchema,
      response: overridesViewSchema,
    },
    authz: onCatalogEntry('overrides.catalog'),
    status: 200,
    version: (input) =>
      catalogOverridesVersion(input.deps, input.params.id ?? '', input.params.vid ?? ''),
    handler: (ctx) => putCatalogOverrides(ctx, ctx.params.id, ctx.params.vid, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/default-overrides',
    tag: OVERRIDES,
    summary: 'Overrides every installation of the entry gets (those of its current version)',
    schema: { params: idParams, response: overridesViewSchema },
    authz: onCatalogEntry('overrides.catalog'),
    handler: (ctx) => getEntryOverrides(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PUT',
    url: '/catalog/{id}/default-overrides',
    tag: OVERRIDES,
    summary: 'Replace the overrides every installation of the entry gets',
    schema: { params: idParams, body: overridesDocSchema, response: overridesViewSchema },
    authz: onCatalogEntry('overrides.catalog'),
    status: 200,
    version: (input) => entryOverridesVersion(input.deps, input.params.id ?? ''),
    handler: (ctx) => putEntryOverrides(ctx, ctx.params.id, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/installations/{id}/overrides',
    tag: OVERRIDES,
    summary: 'Installation-layer overrides',
    schema: { params: idParams, response: overridesViewSchema },
    authz: onInstallation('overrides.installation'),
    handler: (ctx) => getInstallationOverrides(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PUT',
    url: '/installations/{id}/overrides',
    tag: OVERRIDES,
    summary: 'Replace the installation-layer overrides, bounded by userOverrides',
    schema: { params: idParams, body: overridesDocSchema, response: overridesViewSchema },
    authz: onInstallation('overrides.installation'),
    status: 200,
    version: versionOf('installations'),
    handler: (ctx) => putInstallationOverrides(ctx, ctx.params.id, ctx.body),
  }),
  defineRoute({
    method: 'POST',
    url: '/overrides/preview',
    tag: OVERRIDES,
    summary: 'Final definitions and diff for an unsaved overrides document',
    schema: { body: previewBodySchema, response: previewResultSchema },
    authz: authz.personal(),
    readOnly: true,
    handler: async (ctx) => new RouteReply(await preview(ctx, ctx.body)),
  }),
];
