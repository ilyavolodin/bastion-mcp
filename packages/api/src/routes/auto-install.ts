import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import {
  authz,
  defineDelete,
  defineMutation,
  defineRoute,
  type RouteDefinition,
} from '../framework/route';
import { idParams } from '../schemas/common';
import {
  autoInstallCreateSchema,
  autoInstallPatchSchema,
  autoInstallPreviewBody,
  autoInstallPreviewSchema,
  driftApproveSchema,
  driftListQuery,
  driftRejectSchema,
} from '../schemas/installations';
import { asRow, autoInstallPolicyRow, driftReviewRow, pageOf } from '../schemas/rows';
import {
  autoInstallPolicies,
  createPolicy,
  previewPolicy,
  storedTarget,
  targetResource,
  updatePolicy,
} from '../services/auto-install';
import { approveReview, driftReviews, rejectReview } from '../services/drift';
import { org, versionOf } from './shared';

const DRIFT = 'Drift';
const AUTO = 'Auto-install';

const hintTarget = z
  .object({
    target: z
      .object({
        all: z.boolean().optional(),
        teamIds: z.array(z.string()).optional(),
        roles: z.array(z.string()).optional(),
        idpGroups: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .catch({});

const AUTO_RULES = ['auto-install.team', 'auto-install.org'] as const;

const policyTargetAuthz = authz.oneOf(AUTO_RULES, async ({ body }) => {
  const target = hintTarget.parse(body ?? {}).target;
  return target ? targetResource(target as never) : targetResource({ all: true });
});

const storedPolicyAuthz = authz.oneOf(AUTO_RULES, async ({ deps, params }) => {
  const row = await deps.store.get('auto_install_policies', params.id ?? '');
  const target = storedTarget(row);
  return target ? targetResource(target) : targetResource({ all: true });
});

export const driftRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/drift-reviews',
    tag: DRIFT,
    summary: 'Definition drift reviews',
    schema: { query: driftListQuery, response: pageOf('DriftReviewPage', driftReviewRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) =>
      driftReviews.list(ctx, ctx.query, {
        ...(ctx.query.status ? { status: ctx.query.status } : {}),
        ...(ctx.query.installationId ? { installationId: ctx.query.installationId } : {}),
        ...(ctx.query.catalogVersionId ? { catalogVersionId: ctx.query.catalogVersionId } : {}),
      }),
  }),
  defineMutation({
    method: 'POST',
    url: '/drift-reviews/{id}/approve',
    tag: DRIFT,
    summary: 'Approve a changed definition',
    schema: { params: idParams, body: driftApproveSchema, response: asRow(driftReviewRow) },
    authz: authz.on('drift.write', org),
    status: 200,
    handler: (ctx) => approveReview(ctx, ctx.params.id, ctx.body.note),
  }),
  defineMutation({
    method: 'POST',
    url: '/drift-reviews/{id}/reject',
    tag: DRIFT,
    summary: 'Reject a changed definition',
    schema: { params: idParams, body: driftRejectSchema, response: asRow(driftReviewRow) },
    authz: authz.on('drift.write', org),
    status: 200,
    handler: (ctx) => rejectReview(ctx, ctx.params.id, ctx.body.reason),
  }),
];

export const autoInstallRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/auto-install-policies',
    tag: AUTO,
    summary: 'Auto-install policies',
    schema: {
      query: listQuerySchema,
      response: pageOf('AutoInstallPolicyPage', autoInstallPolicyRow),
    },
    authz: authz.on('org.view', org),
    handler: (ctx) => autoInstallPolicies.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/auto-install-policies',
    tag: AUTO,
    summary: 'Create an auto-install policy',
    schema: { body: autoInstallCreateSchema, response: asRow(autoInstallPolicyRow) },
    authz: policyTargetAuthz,
    handler: (ctx) => createPolicy(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/auto-install-policies/{id}',
    tag: AUTO,
    summary: 'Update an auto-install policy',
    schema: {
      params: idParams,
      body: autoInstallPatchSchema,
      response: asRow(autoInstallPolicyRow),
    },
    authz: storedPolicyAuthz,
    version: versionOf('auto_install_policies'),
    handler: (ctx) => updatePolicy(ctx, ctx.params.id, ctx.body),
  }),
  defineDelete({
    url: '/auto-install-policies/{id}',
    tag: AUTO,
    summary: 'Delete an auto-install policy',
    params: idParams,
    authz: storedPolicyAuthz,
    version: versionOf('auto_install_policies'),
    remove: (ctx) => autoInstallPolicies.remove(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'POST',
    url: '/auto-install-policies/{id}/preview',
    tag: AUTO,
    summary: 'Who would get what, with counts',
    schema: { params: idParams, body: autoInstallPreviewBody, response: autoInstallPreviewSchema },
    authz: storedPolicyAuthz,
    readOnly: true,
    handler: (ctx) => {
      const { target, mode, scope, applyToExisting } = ctx.body;
      return previewPolicy(ctx, ctx.params.id, {
        ...(target ? { target } : {}),
        ...(mode ? { mode } : {}),
        ...(scope ? { scope } : {}),
        ...(applyToExisting === undefined ? {} : { applyToExisting }),
      });
    },
  }),
];
