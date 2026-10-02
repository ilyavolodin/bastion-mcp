/**
 * Client-side validation of the override document (12.2) for instant feedback in the raw JSON tab.
 * The server (`POST /overrides/preview`, `PUT /installations/{id}/overrides`) stays authoritative; this
 * mirrors `packages/overrides/src/schema.ts`, which `web` may not import (5.3 leaf rule).
 */
import { z } from 'zod';

const jsonValue = z.json();
const pointer = z.string().regex(/^(\/[^/]*)*$/, 'must be a JSON Pointer (RFC 6901)');
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'must match ^[A-Za-z0-9_.-]{1,128}$');
const description = z.union([
  z.string(),
  z.strictObject({ mode: z.enum(['append', 'prepend', 'replace']), text: z.string() }),
]);

const patchOp = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('replace'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('test'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('remove'), path: pointer }),
  z.strictObject({ op: z.literal('move'), from: pointer, path: pointer }),
  z.strictObject({ op: z.literal('copy'), from: pointer, path: pointer }),
]);

const tool = z.strictObject({
  name: name.optional(),
  title: z.string().optional(),
  description: description.optional(),
  annotations: z
    .strictObject({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  pinnedArguments: z.record(z.string(), jsonValue).optional(),
  defaultArguments: z.record(z.string(), jsonValue).optional(),
  inputSchemaPatch: z.array(patchOp).optional(),
  outputTransform: z
    .strictObject({
      maxTextBytes: z.number().int().positive().optional(),
      dropContentTypes: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  meta: z
    .strictObject({
      set: z.record(z.string(), jsonValue).optional(),
      remove: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
  guardProfileId: z.string().min(1).nullable().optional(),
  hidden: z.boolean().optional(),
});

const message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.looseObject({ type: z.string() }),
});

const prompt = z.strictObject({
  name: name.optional(),
  title: z.string().optional(),
  description: description.optional(),
  arguments: z
    .record(
      z.string(),
      z.strictObject({ pinned: z.string().optional(), hidden: z.boolean().optional() }),
    )
    .optional(),
  messagesTransform: z
    .strictObject({ prepend: z.array(message).optional(), append: z.array(message).optional() })
    .optional(),
  hidden: z.boolean().optional(),
});

const resource = z.strictObject({
  title: z.string().optional(),
  description: description.optional(),
  hidden: z.boolean().optional(),
});

const template = z.strictObject({
  title: z.string().optional(),
  description: description.optional(),
  pinnedVariables: z.record(z.string(), z.string()).optional(),
  hidden: z.boolean().optional(),
});

export const overrideDocumentSchema = z.strictObject({
  // Like `packages/overrides`: a document without `version` is version 1, so `{}` is the empty document.
  version: z.literal(1).default(1),
  uriPrefix: z.boolean().optional(),
  instructions: z
    .strictObject({ mode: z.enum(['append', 'replace']), text: z.string() })
    .optional(),
  tools: z.record(z.string(), tool).optional(),
  prompts: z.record(z.string(), prompt).optional(),
  resources: z.record(z.string(), resource).optional(),
  resourceTemplates: z.record(z.string(), template).optional(),
});

export type OverrideSection = 'tools' | 'prompts' | 'resources' | 'resourceTemplates';

/**
 * The document the editor works on: the shape `overrideDocumentSchema` accepts, with items as open records so form
 * controls can write any field. The API types the body as a plain record (`PUT /installations/{id}/overrides`).
 */
export type OverrideDocument = {
  version: 1;
  uriPrefix?: boolean;
  instructions?: { mode: 'append' | 'replace'; text: string };
} & Partial<Record<OverrideSection, Record<string, Record<string, unknown>>>>;

export type OverrideIssue = { path: string; message: string };
export type OverrideValidation =
  | { ok: true; document: OverrideDocument; issues: [] }
  | { ok: false; document: null; issues: OverrideIssue[] };

export function validateOverrideText(text: string): OverrideValidation {
  let parsed: unknown;
  // Nothing typed is the empty document, never an error.
  if (text.trim() === '') return { ok: true, document: emptyOverrides(), issues: [] };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      document: null,
      issues: [{ path: '', message: e instanceof Error ? e.message : 'Invalid JSON' }],
    };
  }
  const result = overrideDocumentSchema.safeParse(parsed);
  if (result.success) return { ok: true, document: result.data as OverrideDocument, issues: [] };
  return {
    ok: false,
    document: null,
    issues: result.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    })),
  };
}

export const emptyOverrides = (): OverrideDocument => ({ version: 1 });

/** Sets or clears one field of one item in the document (form controls write through this). */
export function setItemField(
  doc: OverrideDocument,
  section: OverrideSection,
  item: string,
  field: string,
  value: unknown,
): OverrideDocument {
  const map = { ...(doc[section] ?? {}) };
  const entry = { ...(map[item] ?? {}) };
  if (value === undefined || value === '' || value === null) delete entry[field];
  else entry[field] = value;
  if (Object.keys(entry).length === 0) delete map[item];
  else map[item] = entry;
  const next: OverrideDocument = { ...doc, [section]: map };
  if (Object.keys(map).length === 0) delete next[section];
  return next;
}

export const setToolField = (doc: OverrideDocument, tool: string, field: string, value: unknown) =>
  setItemField(doc, 'tools', tool, field, value);

export const sectionOf = (kind: 'tool' | 'prompt' | 'resource' | 'template'): OverrideSection =>
  kind === 'tool'
    ? 'tools'
    : kind === 'prompt'
      ? 'prompts'
      : kind === 'resource'
        ? 'resources'
        : 'resourceTemplates';

/** JSON Schema of the document for Monaco's inline validation. */
export const overrideJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(overrideDocumentSchema, { unrepresentable: 'any', io: 'input' }) as Record<
    string,
    unknown
  >;
