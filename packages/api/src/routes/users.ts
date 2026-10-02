import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { authz, defineMutation, defineRoute, type RouteDefinition } from '../framework/route';
import { idParams, itemPage, itemSchema } from '../schemas/common';
import {
  memberBodySchema,
  roleRuleCreateSchema,
  roleRulePatchSchema,
  teamCreateSchema,
  teamPatchSchema,
  userCreateSchema,
  userListQuery,
  userPatchSchema,
} from '../schemas/users';
import {
  assertGroupPattern,
  createTeam,
  createUser,
  deactivateUser,
  deleteTeam,
  listMembers,
  removeMember,
  roleMappingRules,
  setMember,
  teams,
  updateTeam,
  users,
} from '../services/users';
import { org, teamOf, versionOf } from './shared';

const TAG = 'Users and teams';
const memberParams = z.object({ id: z.string().min(1), userId: z.string().min(1) });
const teamWithMembers = itemSchema.extend({ members: z.array(z.looseObject({ id: z.string() })) });

export const usersRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/users',
    tag: TAG,
    summary: 'List users',
    schema: { query: userListQuery, response: itemPage },
    authz: authz.on('org.view', org),
    handler: (ctx) =>
      users.list(ctx, ctx.query, {
        ...(ctx.query.status ? { status: ctx.query.status } : {}),
        ...(ctx.query.orgRole ? { orgRole: ctx.query.orgRole } : {}),
      }),
  }),
  defineMutation({
    method: 'POST',
    url: '/users',
    tag: TAG,
    summary: 'Create a user',
    schema: { body: userCreateSchema, response: itemSchema },
    authz: authz.on('users.write', org),
    handler: (ctx) => createUser(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/users/{id}',
    tag: TAG,
    summary: 'Get a user',
    schema: { params: idParams, response: itemSchema },
    authz: authz.on('org.view', org),
    handler: (ctx) => users.get(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/users/{id}',
    tag: TAG,
    summary: 'Update a user',
    schema: { params: idParams, body: userPatchSchema, response: itemSchema },
    authz: authz.on('users.write', org),
    version: versionOf('users'),
    handler: (ctx) => users.update(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'POST',
    url: '/users/{id}/deactivate',
    tag: TAG,
    summary: 'Deactivate a user: revoke tokens and sessions, stop instances',
    schema: { params: idParams, response: itemSchema },
    authz: authz.on('users.write', org),
    status: 200,
    handler: (ctx) => deactivateUser(ctx, ctx.params.id),
  }),

  defineRoute({
    method: 'GET',
    url: '/teams',
    tag: TAG,
    summary: 'List teams',
    schema: { query: listQuerySchema, response: itemPage },
    authz: authz.on('org.view', org),
    handler: (ctx) => teams.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/teams',
    tag: TAG,
    summary: 'Create a team',
    schema: { body: teamCreateSchema, response: itemSchema },
    authz: authz.on('teams.write', org),
    handler: (ctx) => createTeam(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/teams/{id}',
    tag: TAG,
    summary: 'Get a team with its members',
    schema: { params: idParams, response: teamWithMembers },
    authz: authz.on('team.view', teamOf()),
    handler: async (ctx) => ({
      ...(await teams.get(ctx, ctx.params.id)),
      members: await listMembers(ctx, ctx.params.id),
    }),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/teams/{id}',
    tag: TAG,
    summary: 'Update a team',
    schema: { params: idParams, body: teamPatchSchema, response: itemSchema },
    authz: authz.on('teams.write', org),
    version: versionOf('teams'),
    handler: (ctx) => updateTeam(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/teams/{id}',
    tag: TAG,
    summary: 'Delete a team and its memberships',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('teams.write', org),
    status: 204,
    version: versionOf('teams'),
    handler: async (ctx) => {
      await deleteTeam(ctx, ctx.params.id);
      return null;
    },
  }),
  defineMutation({
    method: 'PUT',
    url: '/teams/{id}/members/{userId}',
    tag: TAG,
    summary: 'Add a member or change their team role',
    schema: { params: memberParams, body: memberBodySchema, response: itemSchema },
    authz: authz.on('teams.members', teamOf()),
    status: 200,
    version: async (input) =>
      (
        await input.deps.store.get(
          'team_members',
          `${input.params.id ?? ''}:${input.params.userId ?? ''}`,
        )
      )?.updatedAt ?? null,
    handler: (ctx) => setMember(ctx, ctx.params.id, ctx.params.userId, ctx.body.role),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/teams/{id}/members/{userId}',
    tag: TAG,
    summary: 'Remove a member from a team',
    schema: { params: memberParams, response: z.null() },
    authz: authz.on('teams.members', teamOf()),
    status: 204,
    version: async (input) =>
      (
        await input.deps.store.get(
          'team_members',
          `${input.params.id ?? ''}:${input.params.userId ?? ''}`,
        )
      )?.updatedAt ?? null,
    handler: async (ctx) => {
      await removeMember(ctx, ctx.params.id, ctx.params.userId);
      return null;
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/role-mapping-rules',
    tag: TAG,
    summary: 'List role-mapping rules',
    schema: { query: listQuerySchema, response: itemPage },
    authz: authz.on('org.view', org),
    handler: (ctx) => roleMappingRules.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/role-mapping-rules',
    tag: TAG,
    summary: 'Create a role-mapping rule',
    schema: { body: roleRuleCreateSchema, response: itemSchema },
    authz: authz.on('users.write', org),
    handler: (ctx) => {
      assertGroupPattern(ctx.body.groupPattern);
      return roleMappingRules.create(ctx, ctx.body);
    },
  }),
  defineMutation({
    method: 'PATCH',
    url: '/role-mapping-rules/{id}',
    tag: TAG,
    summary: 'Update a role-mapping rule',
    schema: { params: idParams, body: roleRulePatchSchema, response: itemSchema },
    authz: authz.on('users.write', org),
    version: versionOf('role_mapping_rules'),
    handler: (ctx) => {
      assertGroupPattern(ctx.body.groupPattern);
      return roleMappingRules.update(ctx, ctx.params.id, ctx.body);
    },
  }),
  defineMutation({
    method: 'DELETE',
    url: '/role-mapping-rules/{id}',
    tag: TAG,
    summary: 'Delete a role-mapping rule',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('users.write', org),
    status: 204,
    version: versionOf('role_mapping_rules'),
    handler: async (ctx) => {
      await roleMappingRules.remove(ctx, ctx.params.id);
      return null;
    },
  }),
];
