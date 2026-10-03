import { DESKTOP_INSTALLATION_MODES, MARKETPLACE_ITEM_POLICIES } from '@bastion-mcp/core';
import { ROLLOUT_CLIENTS } from '@bastion-mcp/plugins';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { nameSchema } from './common';

const atLeastOne = (v: object) => Object.keys(v).length > 0;

export const audienceSchema = z.object({
  org: z.boolean().default(false),
  teamIds: z.array(z.string().min(1)).default([]),
  userIds: z.array(z.string().min(1)).default([]),
});

export const marketplaceCreateSchema = z.object({
  slug: z.string().min(1).max(63),
  displayName: nameSchema,
  description: z.string().max(2000).nullable().default(null),
  /** Null: an org-owned marketplace (admins only); a team id: that team's managers administer it. */
  ownerTeamId: z.string().min(1).nullable().default(null),
  audience: audienceSchema.default({ org: false, teamIds: [], userIds: [] }),
  desktopInstallation: z.enum(DESKTOP_INSTALLATION_MODES).default('available'),
});

export const marketplacePatchSchema = z
  .object({
    displayName: nameSchema,
    description: z.string().max(2000).nullable(),
    audience: audienceSchema,
    desktopInstallation: z.enum(DESKTOP_INSTALLATION_MODES),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const itemParams = z.object({ id: z.string().min(1), entryId: z.string().min(1) });

export const itemBodySchema = z.object({
  policy: z.enum(MARKETPLACE_ITEM_POLICIES).default('available'),
  pinnedVersionId: z.string().min(1).nullable().default(null),
  position: z.number().int().min(0).max(100000).optional(),
});

export const releaseParams = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().min(1),
});

export const releaseSchema = z
  .looseObject({
    seq: z.number().int(),
    gitCommit: z.string(),
    releaseTime: z.string(),
    promoted: z.boolean(),
    /** The plugins the release ships, with the version and policy each had when it was cut. */
    items: z.array(
      z.object({
        name: z.string(),
        version: z.string(),
        policy: z.enum(MARKETPLACE_ITEM_POLICIES),
      }),
    ),
  })
  .meta({ id: 'MarketplaceRelease' });

export const mirrorBodySchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  repo: z.string().min(1).max(512),
  branch: z.string().min(1).max(255).default('main'),
  credentialSecretId: z.string().min(1),
});

export const mirrorTargetSchema = z
  .object({
    provider: z.enum(['github', 'gitlab']),
    repo: z.string(),
    branch: z.string(),
    credentialSecretId: z.string(),
  })
  .meta({ id: 'MirrorTarget' });

/** Where the push to the mirror stands (25.6). */
export const mirrorStateSchema = z
  .looseObject({
    status: z.enum(['idle', 'ok', 'retrying', 'diverged']),
    lastPushedSeq: z.number().int().nullable(),
    attempts: z.number().int(),
    nextAttemptAt: z.string().nullable(),
    lastError: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: 'MirrorState' });

export const mirrorViewSchema = z.object({
  mirror: mirrorTargetSchema.nullable(),
  status: mirrorStateSchema.nullable(),
  updatedAt: z.string(),
});

/**
 * Copy-ready client configuration (25.7). Which fields are present depends on `client`: `claude-code` has
 * `managedSettings`, `strictKnownMarketplacesEntry`, `gitCredentialLine` and `installCommands`; `claude-desktop-3p`
 * `allowedPluginMarketplaces`; `codex` `commands`, `gitCredentialLine` and `requirementsToml`; `claude-ai` and
 * `chatgpt` `steps` and `plugins`. (A flat object keeps the response additive for older clients.)
 */
export const rolloutConfigSchema = z
  .object({
    client: z.enum(ROLLOUT_CLIENTS),
    managedSettings: z
      .object({
        extraKnownMarketplaces: z.record(
          z.string(),
          z.object({
            source: z.object({ source: z.literal('git'), url: z.string() }),
            autoUpdate: z.literal(true),
          }),
        ),
        enabledPlugins: z.record(z.string(), z.literal(true)),
      })
      .optional(),
    strictKnownMarketplacesEntry: z
      .object({ source: z.literal('git'), url: z.string() })
      .optional(),
    gitCredentialLine: z.string().optional(),
    installCommands: z.array(z.string()).optional(),
    allowedPluginMarketplaces: z
      .object({
        gitEntry: z.record(z.string(), z.string()),
        urlEntry: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    commands: z.array(z.string()).optional(),
    requirementsToml: z.string().optional(),
    steps: z.array(z.string()).optional(),
    plugins: z.array(z.object({ name: z.string(), setTo: z.string() })).optional(),
  })
  .meta({ id: 'RolloutConfig' });

export const rolloutQuery = z.object({ client: z.enum(ROLLOUT_CLIENTS) });
export const usageQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
export const marketplaceListQuery = listQuerySchema;
