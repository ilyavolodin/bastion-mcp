import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { authz, defineMutation, defineRoute, type RouteDefinition } from '../framework/route';
import { idParams, itemPage, itemSchema } from '../schemas/common';
import {
  limitRuleCreateSchema,
  limitRulePatchSchema,
  usageQuerySchema,
  usageResultSchema,
} from '../schemas/limits';
import { createLimitRule, limitRules, ruleUsage, updateLimitRule } from '../services/limits';
import { org, versionOf } from './shared';

const TAG = 'Limits';

export const limitsRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/limit-rules',
    tag: TAG,
    summary: 'List limit rules',
    schema: { query: listQuerySchema, response: itemPage },
    authz: authz.on('org.view', org),
    handler: (ctx) => limitRules.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/limit-rules',
    tag: TAG,
    summary: 'Create a limit rule',
    schema: { body: limitRuleCreateSchema, response: itemSchema },
    authz: authz.on('limits.write', org),
    handler: (ctx) => createLimitRule(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/limit-rules/{id}',
    tag: TAG,
    summary: 'Update a limit rule',
    schema: { params: idParams, body: limitRulePatchSchema, response: itemSchema },
    authz: authz.on('limits.write', org),
    version: versionOf('limit_rules'),
    handler: (ctx) => updateLimitRule(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/limit-rules/{id}',
    tag: TAG,
    summary: 'Delete a limit rule',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('limits.write', org),
    status: 204,
    version: versionOf('limit_rules'),
    handler: async (ctx) => {
      await limitRules.remove(ctx, ctx.params.id);
      return null;
    },
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
