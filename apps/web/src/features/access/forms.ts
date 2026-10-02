/**
 * Form schemas and body builders of the Access screens. Each zod schema mirrors the constraints of the request
 * schema it feeds (`packages/api/src/schemas/*`), and each `toBody` returns the generated request type, so a
 * form that drifts from the API does not compile.
 */
import { isValidSlug, slugify } from '@bastion-mcp/core/ids';
import * as React from 'react';
import { z } from 'zod';
import type { Body } from '@/api/schema';

// --- shared helpers ---------------------------------------------------------------------------------------------

export const SLUG_HELP = 'Lowercase letters, digits and dashes, 2 to 40 characters.';
const slug = z.string().refine(isValidSlug, SLUG_HELP);

/** The first message per field of a failed parse, keyed by the top-level field name. */
export const fieldErrors = (error: z.ZodError): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
};

/** Server-side field errors (`/slug`) as a map keyed by field name. */
export const serverFieldErrors = (
  errors: readonly { path: string; message: string }[],
): Record<string, string> =>
  Object.fromEntries(errors.map((e) => [e.path.replace(/^\//, '').split('/')[0] ?? '', e.message]));

/**
 * A "URL name" that follows the display name until the user edits it (derived with core's `slugify`, 40 characters,
 * like the slugs of the API).
 */
export function useSlug(name: string) {
  const [custom, setCustom] = React.useState<string | null>(null);
  const slug = custom ?? slugify(name);
  return {
    slug,
    setSlug: (value: string) => setCustom(value),
    reset: () => setCustom(null),
  };
}

// --- teams ------------------------------------------------------------------------------------------------------

export const teamFormSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name').max(200),
  slug,
  idpGroup: z.string().trim().max(256).optional(),
});
export type TeamForm = z.infer<typeof teamFormSchema>;

export const teamToBody = (v: TeamForm): Body<'post', '/teams'> => ({
  slug: v.slug,
  displayName: v.displayName,
  ...(v.idpGroup ? { idpGroup: v.idpGroup } : {}),
});

// --- service accounts -------------------------------------------------------------------------------------------

const jwkList = z.array(z.record(z.string(), z.string())).min(1, 'Add at least one public key');

/** Accepts a JWKS document (`{ "keys": [...] }`) or a plain array of JWKs. */
export const parseJwks = (text: string): Record<string, string>[] | null => {
  try {
    const raw: unknown = JSON.parse(text);
    const list = Array.isArray(raw) ? raw : (raw as { keys?: unknown } | null)?.keys;
    const parsed = jwkList.safeParse(list);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const serviceAccountFormSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter a name').max(100),
    slug,
    teamId: z.string().min(1, 'Choose a team'),
    authMethod: z.enum(['client_secret_basic', 'private_key_jwt']),
    jwks: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.authMethod === 'private_key_jwt' && !parseJwks(v.jwks ?? '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['jwks'],
        message: 'Paste the public keys as a JWKS document',
      });
    }
  });
export type ServiceAccountForm = z.infer<typeof serviceAccountFormSchema>;

export const serviceAccountToBody = (v: ServiceAccountForm): Body<'post', '/service-accounts'> => ({
  teamId: v.teamId,
  slug: v.slug,
  displayName: v.displayName,
  authMethod: v.authMethod,
  ...(v.authMethod === 'private_key_jwt' ? { jwks: parseJwks(v.jwks ?? '') ?? [] } : {}),
});

// --- IdP group mapping ------------------------------------------------------------------------------------------

export const mappingFormSchema = z
  .object({
    idpConnectionId: z.string(),
    groupPattern: z.string().trim().min(1, 'Enter the IdP group').max(256),
    target: z.enum(['role', 'team', 'createTeam']),
    orgRole: z.enum(['admin', 'auditor', 'member']),
    teamId: z.string(),
    teamRole: z.enum(['manager', 'member']),
    priority: z.coerce.number().int().min(0).max(100000),
  })
  .superRefine((v, ctx) => {
    if (v.target === 'team' && !v.teamId) {
      ctx.addIssue({ code: 'custom', path: ['teamId'], message: 'Choose a team' });
    }
  });
export type MappingForm = {
  idpConnectionId: string;
  groupPattern: string;
  target: 'role' | 'team' | 'createTeam';
  orgRole: 'admin' | 'auditor' | 'member';
  teamId: string;
  teamRole: 'manager' | 'member';
  priority: string;
};

export const mappingToBody = (
  v: z.output<typeof mappingFormSchema>,
): Body<'post', '/role-mapping-rules'> => ({
  idpConnectionId: v.idpConnectionId || null,
  groupPattern: v.groupPattern,
  mapsTo:
    v.target === 'role'
      ? { orgRole: v.orgRole }
      : v.target === 'team'
        ? { teamId: v.teamId, teamRole: v.teamRole }
        : { createTeam: true, teamRole: v.teamRole },
  priority: v.priority,
});

// --- OAuth clients ----------------------------------------------------------------------------------------------

export const oauthClientFormSchema = z.object({
  clientId: z.string().trim().min(1, 'Enter the client id').max(2048),
  preApproved: z.boolean(),
  blocked: z.boolean(),
});
export type OAuthClientForm = z.infer<typeof oauthClientFormSchema>;

export const oauthClientToBody = (v: OAuthClientForm): Body<'post', '/oauth-clients'> => ({
  clientId: v.clientId,
  preApproved: v.preApproved,
  blocked: v.blocked,
});

// --- tool rules -------------------------------------------------------------------------------------------------

export const CIDR = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

export const ruleFormSchema = z.object({
  name: z.string().trim().min(1, 'Name the rule').max(200),
  priority: z.coerce.number().int().min(0).max(100000),
  ownerTeamId: z.string(),
});

// --- custom policies --------------------------------------------------------------------------------------------

export type CustomPolicyBody = Body<'post', '/custom-policies'>;
export type PolicyTest = CustomPolicyBody['tests'][number];

export const policyFormSchema = z.object({
  name: z.string().trim().min(1, 'Name the policy').max(200),
});

export const TEST_ACTIONS = ['callTool', 'seeTool', 'getPrompt', 'readResource'] as const;

/**
 * A test case for a custom policy: "a user with this role (and optionally on this team) does this action on this
 * tool, and the answer is allow or deny". The API validates the policy against these cases (10.3).
 */
export const buildPolicyTest = (input: {
  name: string;
  expect: 'allow' | 'deny';
  action: (typeof TEST_ACTIONS)[number];
  role: 'admin' | 'auditor' | 'member';
  teamId: string;
  teamRole: 'manager' | 'member';
  installationId: string;
  catalogEntryId: string;
  toolName: string;
}): PolicyTest => {
  const installation = { id: input.installationId, catalogEntryId: input.catalogEntryId };
  return {
    name: input.name,
    expect: input.expect,
    request: {
      principal: {
        kind: 'user',
        id: 'test-user',
        role: input.role,
        ...(input.teamId ? { teams: [{ id: input.teamId, role: input.teamRole }] } : {}),
      },
      action: input.action,
      resource:
        input.action === 'getPrompt'
          ? { type: 'Prompt', installation, name: input.toolName }
          : input.action === 'readResource'
            ? { type: 'Resource', installation, uri: input.toolName }
            : { type: 'Tool', installation, name: input.toolName },
    },
  };
};

/** Cedar validator messages are plain strings; "line 3" in one points the editor marker there. */
export const toMarkers = (errors: readonly string[]): { line: number; message: string }[] =>
  errors.map((message) => ({
    line: Number(/line (\d+)/i.exec(message)?.[1] ?? 1),
    message,
  }));
