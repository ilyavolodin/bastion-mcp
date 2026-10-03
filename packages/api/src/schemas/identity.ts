import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';

const atLeastOne = (v: object) => Object.keys(v).length > 0;
const jwkSchema = z.record(z.string(), z.string());

export const serviceAccountCreateSchema = z.object({
  teamId: z.string().min(1),
  slug: z.string().min(1).max(63),
  displayName: z.string().trim().min(1).max(100),
  authMethod: z.enum(['client_secret_basic', 'private_key_jwt']).default('client_secret_basic'),
  jwks: z.array(jwkSchema).optional(),
});

export const serviceAccountPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    status: z.enum(['active', 'disabled']),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const serviceAccountListQuery = listQuerySchema.extend({ teamId: z.string().optional() });

/** Without `jwks` the client secret is rotated; with `jwks` the public keys are replaced. */
export const credentialsBodySchema = z.object({ jwks: z.array(jwkSchema).min(1).optional() });

export const credentialsResponseSchema = z.object({
  clientId: z.string(),
  authMethod: z.enum(['client_secret_basic', 'private_key_jwt']),
  clientSecret: z.string().optional(),
});

export const idpCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  issuer: z.string().url().max(2048),
  discoveryUrl: z.string().url().max(2048),
  clientId: z.string().min(1).max(512),
  /** Write-only: stored in the secret vault, never returned. */
  clientSecret: z.string().min(1).max(4096),
  scopes: z.array(z.string().min(1)).min(1).default(['openid', 'email', 'profile']),
  claimMap: z
    .object({
      email: z.string().optional(),
      name: z.string().optional(),
      groups: z.string().optional(),
      sub: z.string().optional(),
    })
    .default({}),
  emailDomains: z.array(z.string().min(1)).default([]),
  storeRefreshToken: z.boolean().default(false),
  apiScope: z.string().nullable().default(null),
  enterpriseManagedAuth: z.boolean().default(false),
  /** The IdP accepts only the site origin as redirect URI: the sign-in returns to `/` (9.1). */
  redirectToRoot: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const claimMapSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
  groups: z.string().optional(),
  sub: z.string().optional(),
});

export const idpPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    issuer: z.string().url().max(2048),
    discoveryUrl: z.string().url().max(2048),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    scopes: z.array(z.string().min(1)).min(1),
    claimMap: claimMapSchema,
    emailDomains: z.array(z.string().min(1)),
    storeRefreshToken: z.boolean(),
    apiScope: z.string().nullable(),
    enterpriseManagedAuth: z.boolean(),
    redirectToRoot: z.boolean(),
    enabled: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const idpTestResponseSchema = z.object({
  ok: z.boolean(),
  issuer: z.string().optional(),
  issuerMatches: z.boolean().optional(),
  endpoints: z
    .object({
      authorization: z.string().optional(),
      token: z.string().optional(),
      jwks: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

export const scimTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

export const scimTokenCreatedSchema = z.looseObject({
  id: z.string(),
  updatedAt: z.string(),
  token: z.string(),
});

export const oauthClientCreateSchema = z.object({
  clientId: z.string().min(1).max(2048),
  preApproved: z.boolean().default(false),
  blocked: z.boolean().default(false),
});

export const oauthClientPatchSchema = z
  .object({ preApproved: z.boolean(), blocked: z.boolean() })
  .partial()
  .refine(atLeastOne, 'at least one field is required');
