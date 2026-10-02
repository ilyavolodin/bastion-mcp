import { simulateRequestSchema, validatePolicyRequestSchema } from '@bastion-mcp/policy';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { authz, defineMutation, defineRoute, type RouteDefinition } from '../framework/route';
import { idParams, itemPage, itemSchema } from '../schemas/common';
import {
  customPolicyCreateSchema,
  customPolicyPatchSchema,
  policyRuleCreateSchema,
  policyRulePatchSchema,
  simulationResultSchema,
  validationReportSchema,
} from '../schemas/policies';
import {
  createCustomPolicy,
  createRule,
  customPolicies,
  policyRules,
  simulatePolicy,
  updateCustomPolicy,
  updateRule,
  validatePolicy,
} from '../services/policies';
import { org, versionOf } from './shared';

const TAG = 'Policies';

export const policiesRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/policy-rules',
    tag: TAG,
    summary: 'List tool policy rules',
    schema: { query: listQuerySchema, response: itemPage },
    authz: authz.on('org.view', org),
    handler: (ctx) => policyRules.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/policy-rules',
    tag: TAG,
    summary: 'Create a tool policy rule',
    schema: { body: policyRuleCreateSchema, response: itemSchema },
    authz: authz.on('policies.write', org),
    handler: (ctx) => createRule(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/policy-rules/{id}',
    tag: TAG,
    summary: 'Update a tool policy rule',
    schema: { params: idParams, body: policyRulePatchSchema, response: itemSchema },
    authz: authz.on('policies.write', org),
    version: versionOf('policy_rules'),
    handler: (ctx) => updateRule(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/policy-rules/{id}',
    tag: TAG,
    summary: 'Delete a tool policy rule',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('policies.write', org),
    status: 204,
    version: versionOf('policy_rules'),
    handler: async (ctx) => {
      await policyRules.remove(ctx, ctx.params.id);
      return null;
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/custom-policies',
    tag: TAG,
    summary: 'List custom Cedar policies',
    schema: { query: listQuerySchema, response: itemPage },
    authz: authz.on('org.view', org),
    handler: (ctx) => customPolicies.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/custom-policies',
    tag: TAG,
    summary: 'Create a custom Cedar policy (validated, with tests)',
    schema: { body: customPolicyCreateSchema, response: itemSchema },
    authz: authz.on('policies.write', org),
    handler: (ctx) => createCustomPolicy(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/custom-policies/{id}',
    tag: TAG,
    summary: 'Update a custom Cedar policy',
    schema: { params: idParams, body: customPolicyPatchSchema, response: itemSchema },
    authz: authz.on('policies.write', org),
    version: versionOf('custom_policies'),
    handler: (ctx) => updateCustomPolicy(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/custom-policies/{id}',
    tag: TAG,
    summary: 'Delete a custom Cedar policy',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('policies.write', org),
    status: 204,
    version: versionOf('custom_policies'),
    handler: async (ctx) => {
      await customPolicies.remove(ctx, ctx.params.id);
      return null;
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/policies/validate',
    tag: TAG,
    summary: 'Validate Cedar and run its tests without saving',
    schema: { body: validatePolicyRequestSchema, response: validationReportSchema },
    authz: authz.on('policies.write', org),
    readOnly: true,
    handler: (ctx) => validatePolicy(ctx, ctx.body),
  }),
  defineRoute({
    method: 'POST',
    url: '/policies/simulate',
    tag: TAG,
    summary: 'Simulate a decision for any principal, action and resource',
    schema: { body: simulateRequestSchema, response: simulationResultSchema },
    authz: authz.on('policies.write', org),
    readOnly: true,
    handler: (ctx) => simulatePolicy(ctx, ctx.body),
  }),
];
