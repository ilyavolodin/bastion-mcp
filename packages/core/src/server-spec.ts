import { z } from 'zod';
import { TIMEOUTS_MS } from './constants';
import { isValidEgressRule } from './net';
import { assertNoPerUserReferences, TemplateError, validateTemplate } from './template';

/**
 * ServerSpec (8.1) and UpstreamAuthSpec (9.5). Field names follow the MCP Registry `server.json`
 * so registry entries map one to one.
 */

const template = z.string().superRefine((value, ctx) => {
  try {
    validateTemplate(value);
  } catch (error) {
    if (error instanceof TemplateError) ctx.addIssue({ code: 'custom', message: error.message });
    else throw error;
  }
});

const variableSpec = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
  value: template.optional(),
});

const headerSpec = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  value: template.optional(),
});

const argumentSpec = z.object({
  type: z.enum(['positional', 'named']),
  name: z.string().optional(),
  value: template,
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
});

const timeoutSpec = z.object({
  toolCallMs: z.number().int().positive().max(TIMEOUTS_MS.maxOverride).optional(),
  listMs: z.number().int().positive().max(TIMEOUTS_MS.maxOverride).optional(),
});

export const injectionSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('header'), name: z.string().min(1), value: template }),
  z.object({ to: z.literal('env'), name: z.string().min(1), value: template }),
  z.object({
    to: z.literal('arg'),
    position: z.number().int().nonnegative().optional(),
    flag: z.string().optional(),
    value: template,
  }),
]);

const secretField = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const upstreamOAuthClient = z.discriminatedUnion('registration', [
  z.object({
    registration: z.literal('preRegistered'),
    clientId: z.string().min(1),
    clientSecretRef: z.string().optional(),
    authMethod: z.enum(['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none']),
  }),
  z.object({ registration: z.literal('cimd') }),
  z.object({ registration: z.literal('dcr') }),
  z.object({ registration: z.literal('auto') }),
]);

export const upstreamAuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('orgSecret'), inject: z.array(injectionSchema) }),
  z.object({
    mode: z.literal('userSecret'),
    fields: z.array(secretField).min(1),
    inject: z.array(injectionSchema),
  }),
  z.object({
    mode: z.literal('oauth'),
    client: upstreamOAuthClient,
    scopes: z.array(z.string()).optional(),
    inject: z.array(injectionSchema).optional(),
  }),
  z.object({
    mode: z.literal('enterpriseManaged'),
    idpConnectionId: z.string().uuid(),
    scopes: z.array(z.string()).optional(),
    inject: z.array(injectionSchema).optional(),
  }),
  z.object({
    mode: z.literal('tokenExchange'),
    idpConnectionId: z.string().uuid(),
    flavor: z.enum(['rfc8693', 'entra-obo']),
    audience: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    inject: z.array(injectionSchema).optional(),
  }),
]);

/** Exact versions only: semver and PEP 440 shapes; ranges, tags and `latest` are rejected (8.7). */
export const EXACT_VERSION = /^\d+(?:\.\d+)+(?:[-+._]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const exactVersion = z.string().regex(EXACT_VERSION, 'must be an exact version');

const remoteSpec = z.object({
  type: z.literal('remote'),
  transport: z.enum(['streamable-http', 'sse']),
  url: z.string().min(1),
  variables: z.record(z.string(), variableSpec).optional(),
  headers: z.array(headerSpec).optional(),
  auth: upstreamAuthSchema,
  tls: z
    .object({ caBundleSecret: z.string().optional(), clientCertSecret: z.string().optional() })
    .optional(),
  timeouts: timeoutSpec.optional(),
});

const packageSpec = z.object({
  type: z.literal('package'),
  runtime: z.enum(['npm', 'pypi']),
  identifier: z.string().min(1),
  version: exactVersion,
  bin: z.string().optional(),
  packageArguments: z.array(argumentSpec).optional(),
  environmentVariables: z.array(variableSpec).optional(),
  lockfile: z
    .object({
      kind: z.enum(['npm-shrinkwrap', 'uv-requirements']),
      content: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  protocol: z.enum(['legacy', 'modern', 'auto']).default('legacy'),
  size: z.enum(['small', 'medium', 'large']).default('small'),
  egress: z
    .object({
      allow: z.array(
        z.string().refine(isValidEgressRule, 'must be host[:port], *.suffix[:port] or a CIDR'),
      ),
    })
    .default({ allow: [] }),
  workspace: z
    .object({ persistent: z.boolean(), sizeMiB: z.number().int().positive() })
    .default({ persistent: false, sizeMiB: 512 }),
  allowInstallScripts: z.boolean().default(false),
  idleTimeoutMinutes: z.number().int().min(1).max(1440).default(15),
  instanceScope: z.enum(['perUser', 'shared']).default('perUser'),
  auth: upstreamAuthSchema,
  timeouts: timeoutSpec.optional(),
});

export type ServerSpec = z.infer<typeof serverSpecSchema>;
export type PackageSpec = Extract<ServerSpec, { type: 'package' }>;
export type RemoteSpec = Extract<ServerSpec, { type: 'remote' }>;
export type UpstreamAuthSpec = z.infer<typeof upstreamAuthSchema>;
export type Injection = z.infer<typeof injectionSchema>;

/** Every `{{ }}` template string in a spec: arguments, env, headers, URL and injections. */
export const serverSpecTemplates = (spec: ServerSpec): string[] => {
  const out: string[] = [];
  const auth = spec.auth;
  if ('inject' in auth && auth.inject) out.push(...auth.inject.map((i) => i.value));
  if (spec.type === 'package') {
    out.push(...(spec.packageArguments ?? []).map((a) => a.value));
    out.push(...(spec.environmentVariables ?? []).flatMap((v) => (v.value ? [v.value] : [])));
  } else {
    out.push(...(spec.headers ?? []).flatMap((h) => (h.value ? [h.value] : [])));
  }
  return out;
};

export const serverSpecSchema = z
  .discriminatedUnion('type', [remoteSpec, packageSpec])
  .superRefine((spec, ctx) => {
    if (spec.type !== 'package' || spec.instanceScope !== 'shared') return;
    // 8.6: shared instances cannot carry per-user credentials or values.
    if (spec.auth.mode !== 'none' && spec.auth.mode !== 'orgSecret') {
      ctx.addIssue({
        code: 'custom',
        path: ['instanceScope'],
        message: 'shared instances require auth mode none or orgSecret',
      });
    }
    try {
      assertNoPerUserReferences(serverSpecTemplates(spec));
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      ctx.addIssue({ code: 'custom', path: ['instanceScope'], message: error.message });
    }
  });

export const parseServerSpec = (input: unknown): ServerSpec => serverSpecSchema.parse(input);

/** True for semver and PEP 440 exact versions; ranges, tags and `latest` are rejected (8.7). */
export const isExactVersion = (version: string): boolean => EXACT_VERSION.test(version);
