/**
 * Layer merging (12.3): the installation layer overrides the catalog layer field by field;
 * `inputSchemaPatch` lists concatenate, catalog first. Every operation here is associative and has
 * the empty document (or empty item override) as its identity.
 */
import type {
  AnnotationsOverride,
  MessagesTransform,
  MetaOverride,
  OutputTransform,
  OverridesDocument,
  PromptArgumentOverride,
  PromptOverride,
  ResourceOverride,
  ResourceTemplateOverride,
  ToolOverride,
} from './schema';

type Rec<T> = Record<string, T>;

/** `b` wins when it is defined. */
const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => (b === undefined ? a : b);

const mergeWith = <T>(a: T | undefined, b: T | undefined, fn: (x: T, y: T) => T): T | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return fn(a, b);
};

/** Key-wise merge of two records; `b` wins on shared keys. */
const mergeRecord = <T>(a: Rec<T> | undefined, b: Rec<T> | undefined): Rec<T> | undefined =>
  mergeWith(a, b, (x, y) => ({ ...x, ...y }));

const mergeRecordDeep = <T>(
  a: Rec<T> | undefined,
  b: Rec<T> | undefined,
  fn: (x: T, y: T) => T,
): Rec<T> | undefined =>
  mergeWith(a, b, (x, y) => {
    const out: Rec<T> = { ...x };
    for (const [key, value] of Object.entries(y)) {
      const existing = out[key];
      out[key] = existing === undefined ? value : fn(existing, value);
    }
    return out;
  });

const concat = <T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined =>
  mergeWith(a, b, (x, y) => [...x, ...y]);

/** Builds an object keeping only defined entries (required by exactOptionalPropertyTypes). */
const compact = <T extends object>(entries: { [K in keyof T]-?: T[K] | undefined }): T => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out as T;
};

const mergeOutputTransform = (a: OutputTransform, b: OutputTransform): OutputTransform =>
  compact<OutputTransform>({
    maxTextBytes: pick(a.maxTextBytes, b.maxTextBytes),
    dropContentTypes: pick(a.dropContentTypes, b.dropContentTypes),
  });

const mergeMeta = (a: MetaOverride, b: MetaOverride): MetaOverride =>
  compact<MetaOverride>({
    set: mergeRecord(a.set, b.set),
    remove: concat(a.remove, b.remove),
  });

const mergeAnnotations = (a: AnnotationsOverride, b: AnnotationsOverride): AnnotationsOverride =>
  compact<AnnotationsOverride>({
    title: pick(a.title, b.title),
    readOnlyHint: pick(a.readOnlyHint, b.readOnlyHint),
    destructiveHint: pick(a.destructiveHint, b.destructiveHint),
    idempotentHint: pick(a.idempotentHint, b.idempotentHint),
    openWorldHint: pick(a.openWorldHint, b.openWorldHint),
  });

export const mergeToolOverride = (a: ToolOverride, b: ToolOverride): ToolOverride =>
  compact<ToolOverride>({
    name: pick(a.name, b.name),
    title: pick(a.title, b.title),
    description: pick(a.description, b.description),
    annotations: mergeWith(a.annotations, b.annotations, mergeAnnotations),
    pinnedArguments: mergeRecord(a.pinnedArguments, b.pinnedArguments),
    defaultArguments: mergeRecord(a.defaultArguments, b.defaultArguments),
    inputSchemaPatch: concat(a.inputSchemaPatch, b.inputSchemaPatch),
    outputTransform: mergeWith(a.outputTransform, b.outputTransform, mergeOutputTransform),
    meta: mergeWith(a.meta, b.meta, mergeMeta),
    timeoutMs: pick(a.timeoutMs, b.timeoutMs),
    guardProfileId: pick(a.guardProfileId, b.guardProfileId),
    hidden: pick(a.hidden, b.hidden),
  });

const mergePromptArgument = (
  a: PromptArgumentOverride,
  b: PromptArgumentOverride,
): PromptArgumentOverride =>
  compact<PromptArgumentOverride>({
    pinned: pick(a.pinned, b.pinned),
    hidden: pick(a.hidden, b.hidden),
  });

const mergeMessagesTransform = (a: MessagesTransform, b: MessagesTransform): MessagesTransform =>
  compact<MessagesTransform>({
    prepend: pick(a.prepend, b.prepend),
    append: pick(a.append, b.append),
  });

export const mergePromptOverride = (a: PromptOverride, b: PromptOverride): PromptOverride =>
  compact<PromptOverride>({
    name: pick(a.name, b.name),
    title: pick(a.title, b.title),
    description: pick(a.description, b.description),
    arguments: mergeRecordDeep(a.arguments, b.arguments, mergePromptArgument),
    messagesTransform: mergeWith(a.messagesTransform, b.messagesTransform, mergeMessagesTransform),
    hidden: pick(a.hidden, b.hidden),
  });

export const mergeResourceOverride = (a: ResourceOverride, b: ResourceOverride): ResourceOverride =>
  compact<ResourceOverride>({
    title: pick(a.title, b.title),
    description: pick(a.description, b.description),
    hidden: pick(a.hidden, b.hidden),
  });

export const mergeResourceTemplateOverride = (
  a: ResourceTemplateOverride,
  b: ResourceTemplateOverride,
): ResourceTemplateOverride =>
  compact<ResourceTemplateOverride>({
    title: pick(a.title, b.title),
    description: pick(a.description, b.description),
    pinnedVariables: mergeRecord(a.pinnedVariables, b.pinnedVariables),
    hidden: pick(a.hidden, b.hidden),
  });

const mergeItems = <T>(a: Rec<T>, b: Rec<T>, fn: (x: T, y: T) => T): Rec<T> =>
  mergeRecordDeep(a, b, fn) ?? {};

/** Installation (`b`) over catalog (`a`), field by field; neither input is modified. */
export const mergeLayers = (
  catalogDoc: OverridesDocument,
  installationDoc: OverridesDocument,
): OverridesDocument => {
  const out: OverridesDocument = {
    version: 1,
    tools: mergeItems(catalogDoc.tools, installationDoc.tools, mergeToolOverride),
    prompts: mergeItems(catalogDoc.prompts, installationDoc.prompts, mergePromptOverride),
    resources: mergeItems(catalogDoc.resources, installationDoc.resources, mergeResourceOverride),
    resourceTemplates: mergeItems(
      catalogDoc.resourceTemplates,
      installationDoc.resourceTemplates,
      mergeResourceTemplateOverride,
    ),
  };
  const uriPrefix = pick(catalogDoc.uriPrefix, installationDoc.uriPrefix);
  if (uriPrefix !== undefined) out.uriPrefix = uriPrefix;
  const instructions = pick(catalogDoc.instructions, installationDoc.instructions);
  if (instructions !== undefined) out.instructions = instructions;
  return out;
};
