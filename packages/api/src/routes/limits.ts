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
  limitRuleCreateSchema,
  limitRulePatchSchema,
  usageQuerySchema,
  usageResultSchema,
} from '../schemas/limits';
import { asRow, limitRuleRow, pageOf } from '../schemas/rows';
import { createLimitRule, limitRules, ruleUsage, updateLimitRule } from '../services/limits';
import { org, versionOf } from './shared';

const TAG = 'Limits';

export const limitsRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/limit-rules',
    tag: TAG,
    summary: 'List limit rules',
    schema: { query: listQuerySchema, response: pageOf('LimitRulePage', limitRuleRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => limitRules.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/limit-rules',
    tag: TAG,
    summary: 'Create a limit rule',
    schema: { body: limitRuleCreateSchema, response: asRow(limitRuleRow) },
    authz: authz.on('limits.write', org),
    handler: (ctx) => createLimitRule(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/limit-rules/{id}',
    tag: TAG,
    summary: 'Update a limit rule',
    schema: { params: idParams, body: limitRulePatchSchema, response: asRow(limitRuleRow) },
    authz: authz.on('limits.write', org),
    version: versionOf('limit_rules'),
    handler: (ctx) => updateLimitRule(ctx, ctx.params.id, ctx.body),
  }),
  defineDelete({
    url: '/limit-rules/{id}',
    tag: TAG,
    summary: 'Delete a limit rule',
    params: idParams,
    authz: authz.on('limits.write', org),
    version: versionOf('limit_rules'),
    remove: (ctx) => limitRules.remove(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'GET',
    url: '/limit-rules/{id}/usage',
    tag: TAG,
    summary: 'Current consumption of a rule',
    schema: { params: idParams, query: usageQuerySchema, response: usageResultSchema },
    authz: authz.on('org.view', org),
    handler: (ctx) => ruleUsage(ctx, ctx.params.id, ctx.query.subjectId),
  }),
];
