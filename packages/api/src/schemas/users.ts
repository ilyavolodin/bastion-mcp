import { ORG_ROLES, TEAM_ROLES, USER_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { nameSchema } from './common';

const atLeastOne = (v: object) => Object.keys(v).length > 0;

export const userCreateSchema = z.object({
  email: z.string().email().max(320),
  displayName: nameSchema,
  orgRole: z.enum(ORG_ROLES).default('member'),
});

export const userPatchSchema = z
  .object({
    displayName: nameSchema,
    orgRole: z.enum(ORG_ROLES),
    catalogPublishOrgWide: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const userListQuery = listQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  orgRole: z.enum(ORG_ROLES).optional(),
});

export const teamCreateSchema = z.object({
  slug: z.string().min(1).max(63),
  displayName: nameSchema,
  idpGroup: z.string().min(1).max(256).nullable().optional(),
});

export const teamPatchSchema = z
  .object({
    slug: z.string().min(1).max(63),
    displayName: nameSchema,
    idpGroup: z.string().min(1).max(256).nullable(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const memberBodySchema = z.object({ role: z.enum(TEAM_ROLES).default('member') });

export const mapsToSchema = z.union([
  z.object({ orgRole: z.enum(ORG_ROLES) }).strict(),
  z.object({ teamId: z.string().min(1), teamRole: z.enum(TEAM_ROLES) }).strict(),
  z.object({ createTeam: z.literal(true), teamRole: z.enum(TEAM_ROLES).optional() }).strict(),
]);

export const roleRuleCreateSchema = z.object({
  idpConnectionId: z.string().min(1).nullable().default(null),
  groupPattern: z.string().min(1).max(256),
  mapsTo: mapsToSchema,
  priority: z.number().int().min(0).max(100000).default(100),
});

export const roleRulePatchSchema = z
  .object({
    idpConnectionId: z.string().min(1).nullable(),
    groupPattern: z.string().min(1).max(256),
    mapsTo: mapsToSchema,
    priority: z.number().int().min(0).max(100000),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');
