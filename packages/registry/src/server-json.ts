import { z } from 'zod';

/**
 * MCP Registry `server.json` (schema 2025-12-11) and the v0.1 REST envelopes (11.6). Objects are loose:
 * registries add fields, and unknown ones must survive the mirror untouched.
 */

export const REGISTRY_OFFICIAL_META = 'io.modelcontextprotocol.registry/official';
export const REGISTRY_PUBLISHER_META = 'io.modelcontextprotocol.registry/publisher-provided';

export const REGISTRY_TYPES = ['npm', 'pypi', 'oci', 'nuget', 'mcpb'] as const;
export const SERVER_STATUSES = ['active', 'deprecated', 'deleted'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

const metaSchema = z.record(z.string(), z.unknown());

const variableSchema = z.looseObject({
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
  format: z.string().optional(),
  value: z.string().optional(),
  placeholder: z.string().optional(),
});
export type ServerJsonVariable = z.infer<typeof variableSchema>;

const variablesSchema = z.record(z.string(), variableSchema);

const keyValueSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
  format: z.string().optional(),
  value: z.string().optional(),
  variables: variablesSchema.optional(),
});
export type ServerJsonKeyValue = z.infer<typeof keyValueSchema>;

const argumentSchema = z.looseObject({
  type: z.enum(['positional', 'named']),
  name: z.string().optional(),
  valueHint: z.string().optional(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isRepeated: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
  format: z.string().optional(),
  value: z.string().optional(),
  variables: variablesSchema.optional(),
});
export type ServerJsonArgument = z.infer<typeof argumentSchema>;

const transportSchema = z.looseObject({
  type: z.enum(['stdio', 'streamable-http', 'sse']),
  url: z.string().optional(),
  headers: z.array(keyValueSchema).optional(),
  variables: variablesSchema.optional(),
});

const packageSchema = z.looseObject({
  registryType: z.enum(REGISTRY_TYPES),
  registryBaseUrl: z.string().optional(),
  identifier: z.string().min(1),
  version: z.string().min(1),
  fileSha256: z.string().optional(),
  runtimeHint: z.string().optional(),
  transport: transportSchema,
  runtimeArguments: z.array(argumentSchema).optional(),
  packageArguments: z.array(argumentSchema).optional(),
  environmentVariables: z.array(keyValueSchema).optional(),
});
export type ServerJsonPackage = z.infer<typeof packageSchema>;

const remoteSchema = z.looseObject({
  type: z.enum(['streamable-http', 'sse']),
  url: z.string().min(1),
  headers: z.array(keyValueSchema).optional(),
  variables: variablesSchema.optional(),
});
export type ServerJsonRemote = z.infer<typeof remoteSchema>;

export const serverJsonSchema = z.looseObject({
  $schema: z.string().optional(),
  name: z.string().min(3),
  title: z.string().optional(),
  description: z.string().default(''),
  version: z.string().min(1),
  websiteUrl: z.string().optional(),
  repository: z
    .looseObject({
      url: z.string(),
      source: z.string().optional(),
      id: z.string().optional(),
      subfolder: z.string().optional(),
    })
    .optional(),
  packages: z.array(packageSchema).optional(),
  remotes: z.array(remoteSchema).optional(),
  _meta: metaSchema.optional(),
});
export type ServerJson = z.infer<typeof serverJsonSchema>;

const officialMetaSchema = z.looseObject({
  status: z.enum(SERVER_STATUSES).optional(),
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  isLatest: z.boolean().optional(),
});

/** One element of a list response: the `server.json` plus registry-managed `_meta` (status, isLatest, ...). */
export const registryEntrySchema = z.looseObject({
  server: serverJsonSchema,
  _meta: metaSchema.optional(),
  // Older registries put these beside `server`.
  status: z.enum(SERVER_STATUSES).optional(),
  publishedAt: z.string().optional(),
  isLatest: z.boolean().optional(),
});

export const listEnvelopeSchema = z.looseObject({
  servers: z.array(z.unknown()),
  metadata: z
    .looseObject({ nextCursor: z.string().nullish(), count: z.number().int().optional() })
    .optional(),
});

/** A validated, flattened registry entry as the mirror stores it. */
export type RegistryEntry = {
  name: string;
  version: string;
  serverJson: ServerJson;
  status: ServerStatus;
  publishedAt: Date | null;
  updatedAt: Date | null;
  isLatest: boolean;
  /** The entry-level `_meta` exactly as the registry sent it. */
  meta: Record<string, unknown>;
};

const toDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Validates one list element and flattens status, dates and `isLatest` from either envelope style. */
export const parseRegistryEntry = (input: unknown): RegistryEntry => {
  const parsed = registryEntrySchema.parse(input);
  const meta = parsed._meta ?? {};
  const official = officialMetaSchema.safeParse(meta[REGISTRY_OFFICIAL_META]);
  const o = official.success ? official.data : {};
  return {
    name: parsed.server.name,
    version: parsed.server.version,
    serverJson: parsed.server,
    status: o.status ?? parsed.status ?? 'active',
    publishedAt: toDate(o.publishedAt ?? parsed.publishedAt),
    updatedAt: toDate(o.updatedAt),
    isLatest: o.isLatest ?? parsed.isLatest ?? false,
    meta,
  };
};

/** Server name as used in registry path parameters: `io.github.acme%2Fserver`. */
export const encodeRegistryName = (name: string): string => encodeURIComponent(name);
