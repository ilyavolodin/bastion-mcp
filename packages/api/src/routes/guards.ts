import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { authz, defineMutation, defineRoute, type RouteDefinition } from '../framework/route';
import { idParams, itemPage, itemSchema } from '../schemas/common';
import {
  guardProfileCreateSchema,
  guardProfilePatchSchema,
  guardTestBodySchema,
  guardTestResultSchema,
  modelGuardsResponse,
  modelGuardsSchema,
} from '../schemas/guards';
import { asRow, guardProfileRow, pageOf, untyped } from '../schemas/rows';
import {
  createProfile,
  getModelGuards,
  guardProfiles,
  modelGuardsVersion,
  putModelGuards,
  testProfile,
  updateProfile,
} from '../services/guards';
import { org, versionOf } from './shared';

const TAG = 'Guards';

export const guardsRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/guard-profiles',
    tag: TAG,
    summary: 'List guard profiles',
    schema: { query: listQuerySchema, response: pageOf('GuardProfilePage', guardProfileRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => guardProfiles.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/guard-profiles',
    tag: TAG,
    summary: 'Create a guard profile',
    schema: { body: guardProfileCreateSchema, response: asRow(guardProfileRow) },
    authz: authz.on('guards.write', org),
    handler: (ctx) => createProfile(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/guard-profiles/{id}',
    tag: TAG,
    summary: 'Get a guard profile',
    schema: { params: idParams, response: asRow(guardProfileRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => guardProfiles.get(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/guard-profiles/{id}',
    tag: TAG,
    summary: 'Update a guard profile',
    schema: { params: idParams, body: guardProfilePatchSchema, response: asRow(guardProfileRow) },
    authz: authz.on('guards.write', org),
    version: versionOf('guard_profiles'),
    handler: (ctx) => updateProfile(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/guard-profiles/{id}',
    tag: TAG,
    summary: 'Delete a guard profile',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('guards.write', org),
    status: 204,
    version: versionOf('guard_profiles'),
    handler: async (ctx) => {
      await guardProfiles.remove(ctx, ctx.params.id);
      return null;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/guard-profiles/{id}/test',
    tag: TAG,
    summary: 'Run a profile against sample text',
    schema: { params: idParams, body: guardTestBodySchema, response: guardTestResultSchema },
    authz: authz.on('guards.write', org),
    readOnly: true,
    handler: (ctx) => testProfile(ctx, ctx.params.id, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/settings/model-guards',
    tag: TAG,
    summary: 'Model-based guard settings',
    schema: { response: untyped(modelGuardsResponse) },
    authz: authz.on('org.view', org),
    handler: (ctx) => getModelGuards(ctx),
  }),
  defineMutation({
    method: 'PUT',
    url: '/settings/model-guards',
    tag: TAG,
    summary: 'Replace the model-based guard settings',
    schema: { body: modelGuardsSchema, response: untyped(modelGuardsResponse) },
    authz: authz.on('guards.write', org),
    status: 200,
    version: (input) => modelGuardsVersion(input),
    handler: (ctx) => putModelGuards(ctx, ctx.body),
  }),
];
