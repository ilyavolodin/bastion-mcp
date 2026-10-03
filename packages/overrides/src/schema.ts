/**
 * The override document (12.2). This zod schema is the single source of truth for the UI form and
 * the control-plane API.
 */
import { NAME_PATTERN } from '@bastion-mcp/core';
import { z } from 'zod';

const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;
export type JsonObject = { [key: string]: JsonValue };

export const textModeSchema = z.enum(['append', 'prepend', 'replace']);

/** `description` is a plain string (replace) or `{ mode, text }` (12.3). */
export const descriptionOverrideSchema = z.union([
  z.string(),
  z.strictObject({ mode: textModeSchema, text: z.string() }),
]);
export type DescriptionOverride = z.infer<typeof descriptionOverrideSchema>;

export const instructionsOverrideSchema = z.strictObject({
  mode: z.enum(['append', 'replace']),
  text: z.string(),
});
export type InstructionsOverride = z.infer<typeof instructionsOverrideSchema>;

export const annotationsSchema = z.strictObject({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type AnnotationsOverride = z.infer<typeof annotationsSchema>;

const pointer = z.string().regex(/^(\/[^/]*)*$/, 'must be a JSON Pointer (RFC 6901)');

/** RFC 6902 operations. */
export const jsonPatchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('replace'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('test'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('remove'), path: pointer }),
  z.strictObject({ op: z.literal('move'), from: pointer, path: pointer }),
  z.strictObject({ op: z.literal('copy'), from: pointer, path: pointer }),
]);
export type JsonPatchOperation = z.infer<typeof jsonPatchOperationSchema>;

export const outputTransformSchema = z.strictObject({
  maxTextBytes: z.number().int().positive().optional(),
  dropContentTypes: z.array(z.string().min(1)).optional(),
});
export type OutputTransform = z.infer<typeof outputTransformSchema>;

export const metaOverrideSchema = z.strictObject({
  set: z.record(z.string(), jsonValue).optional(),
  remove: z.array(z.string().min(1)).optional(),
});
export type MetaOverride = z.infer<typeof metaOverrideSchema>;

export const toolOverrideSchema = z.strictObject({
  name: z.string().regex(NAME_PATTERN, 'must match ^[A-Za-z0-9_.-]{1,128}$').optional(),
  title: z.string().optional(),
  description: descriptionOverrideSchema.optional(),
  annotations: annotationsSchema.optional(),
  pinnedArguments: z.record(z.string(), jsonValue).optional(),
  defaultArguments: z.record(z.string(), jsonValue).optional(),
  inputSchemaPatch: z.array(jsonPatchOperationSchema).optional(),
  outputTransform: outputTransformSchema.optional(),
  meta: metaOverrideSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  guardProfileId: z.string().min(1).nullable().optional(),
  hidden: z.boolean().optional(),
});
export type ToolOverride = z.infer<typeof toolOverrideSchema>;

const promptMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.looseObject({ type: z.string() }),
});
export type PromptMessage = z.infer<typeof promptMessageSchema>;

export const promptArgumentOverrideSchema = z.strictObject({
  pinned: z.string().optional(),
  hidden: z.boolean().optional(),
});
export type PromptArgumentOverride = z.infer<typeof promptArgumentOverrideSchema>;

export const messagesTransformSchema = z.strictObject({
  prepend: z.array(promptMessageSchema).optional(),
  append: z.array(promptMessageSchema).optional(),
});
export type MessagesTransform = z.infer<typeof messagesTransformSchema>;

export const promptOverrideSchema = z.strictObject({
  name: z.string().regex(NAME_PATTERN).optional(),
  title: z.string().optional(),
  description: descriptionOverrideSchema.optional(),
  arguments: z.record(z.string(), promptArgumentOverrideSchema).optional(),
  messagesTransform: messagesTransformSchema.optional(),
  hidden: z.boolean().optional(),
});
export type PromptOverride = z.infer<typeof promptOverrideSchema>;

export const resourceOverrideSchema = z.strictObject({
  title: z.string().optional(),
  description: descriptionOverrideSchema.optional(),
  hidden: z.boolean().optional(),
});
export type ResourceOverride = z.infer<typeof resourceOverrideSchema>;

export const resourceTemplateOverrideSchema = z.strictObject({
  title: z.string().optional(),
  description: descriptionOverrideSchema.optional(),
  pinnedVariables: z.record(z.string(), z.string()).optional(),
  hidden: z.boolean().optional(),
});
export type ResourceTemplateOverride = z.infer<typeof resourceTemplateOverrideSchema>;

export const ADDED_LIMITS = {
  items: 50,
  messages: 20,
  textChars: 100_000,
} as const;

const uriKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:/, 'must be a URI with a scheme, such as notes://welcome')
  .refine((v) => !/^(skill|bastion\+[^:]*):/i.test(v), 'this scheme is reserved by Bastion');
const addedText = z.string().max(ADDED_LIMITS.textChars);

export const addedPromptArgumentSchema = z.strictObject({
  name: z.string().regex(NAME_PATTERN, 'must match ^[A-Za-z0-9_.-]{1,128}$'),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

/** A prompt Bastion itself serves: fixed messages in which `{{argument}}` is replaced by what the client passes. */
export const addedPromptSchema = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z.array(addedPromptArgumentSchema).max(ADDED_LIMITS.items).optional(),
  messages: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), text: addedText }))
    .min(1)
    .max(ADDED_LIMITS.messages),
});
export type AddedPrompt = z.infer<typeof addedPromptSchema>;

/** A resource Bastion itself serves: fixed text. */
export const addedResourceSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().min(1).optional(),
  text: addedText,
});
export type AddedResource = z.infer<typeof addedResourceSchema>;

/** A resource template Bastion itself serves: text in which `{{variable}}` is replaced by the URI's variables. */
export const addedResourceTemplateSchema = addedResourceSchema;
export type AddedResourceTemplate = AddedResource;

export const addedSchema = z.strictObject({
  prompts: z.record(z.string().regex(NAME_PATTERN), addedPromptSchema).optional(),
  resources: z.record(uriKey, addedResourceSchema).optional(),
  resourceTemplates: z.record(uriKey, addedResourceTemplateSchema).optional(),
});
export type AddedItems = z.infer<typeof addedSchema>;

export const overridesSchema = z.strictObject({
  version: z.literal(1).default(1),
  uriPrefix: z.boolean().optional(),
  instructions: instructionsOverrideSchema.optional(),
  tools: z.record(z.string().min(1), toolOverrideSchema).default({}),
  prompts: z.record(z.string().min(1), promptOverrideSchema).default({}),
  resources: z.record(z.string().min(1), resourceOverrideSchema).default({}),
  resourceTemplates: z.record(z.string().min(1), resourceTemplateOverrideSchema).default({}),
  /** Prompts and resources Bastion hosts itself, in addition to the upstream's. */
  added: addedSchema.optional(),
});
export type OverridesDocument = z.output<typeof overridesSchema>;
export type OverridesInput = z.input<typeof overridesSchema>;

export type ParseIssue = { path: string; message: string };
export type ParseResult =
  | { ok: true; doc: OverridesDocument }
  | { ok: false; issues: ParseIssue[] };

/** Parses untrusted input (HTTP body, JSONB column) into an override document. Never throws. */
export const parseOverrides = (input: unknown): ParseResult => {
  const result = overridesSchema.safeParse(input);
  if (result.success) return { ok: true, doc: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: `/${issue.path.map(String).join('/')}`,
      message: issue.message,
    })),
  };
};

export const emptyOverrides = (): OverridesDocument => ({
  version: 1,
  tools: {},
  prompts: {},
  resources: {},
  resourceTemplates: {},
});
