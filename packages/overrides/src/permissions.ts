/**
 * Layer permissions (12.1). The installation layer may set only what the catalog entry's
 * `userOverrides` level allows; the catalog layer is unrestricted.
 */
import type {
  AnnotationsOverride,
  OverridesDocument,
  PromptOverride,
  ResourceOverride,
  ResourceTemplateOverride,
  ToolOverride,
} from './schema';

export type UserOverridesLevel = 'none' | 'cosmetic' | 'full';

export type Rejection = { path: string; reason: string };

export type FilterResult = { doc: OverridesDocument; rejected: Rejection[] };

const RANK: Record<UserOverridesLevel, number> = { none: 0, cosmetic: 1, full: 2 };

/** Pointer segment escaping (RFC 6901) so keys containing `/` stay unambiguous. */
const seg = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

const needs = (level: UserOverridesLevel, required: UserOverridesLevel): boolean =>
  RANK[level] >= RANK[required];

const levelReason = (field: string, required: UserOverridesLevel, level: UserOverridesLevel) =>
  `${field} requires userOverrides "${required}" (this entry allows "${level}")`;

const isEmpty = (value: object): boolean => Object.keys(value).length === 0;

type Field<T> = { key: keyof T & string; required: UserOverridesLevel };

/** Copies the allowed fields of `item`, recording a rejection for each forbidden one. */
const filterFields = <T extends object>(
  item: T,
  fields: readonly Field<T>[],
  level: UserOverridesLevel,
  base: string,
  rejected: Rejection[],
): T => {
  const out: Record<string, unknown> = {};
  const source = item as Record<string, unknown>;
  for (const { key, required } of fields) {
    const value = source[key];
    if (value === undefined) continue;
    if (needs(level, required)) out[key] = value;
    else rejected.push({ path: `${base}/${key}`, reason: levelReason(key, required, level) });
  }
  return out as T;
};

const SAFER: ReadonlyArray<readonly [keyof AnnotationsOverride & string, boolean]> = [
  ['readOnlyHint', true],
  ['destructiveHint', false],
  ['openWorldHint', false],
];

const filterAnnotations = (
  annotations: AnnotationsOverride,
  base: string,
  rejected: Rejection[],
): AnnotationsOverride => {
  const out: Record<string, unknown> = { ...annotations };
  for (const [key, bad] of SAFER) {
    if (out[key] === bad) {
      delete out[key];
      rejected.push({
        path: `${base}/${key}`,
        reason: `${key}: ${String(bad)} makes a tool look safer and may only be set in the catalog layer`,
      });
    }
  }
  return out as AnnotationsOverride;
};

const filterTool = (
  tool: ToolOverride,
  level: UserOverridesLevel,
  base: string,
  rejected: Rejection[],
): ToolOverride => {
  const out = filterFields<ToolOverride>(
    tool,
    [
      { key: 'name', required: 'cosmetic' },
      { key: 'title', required: 'cosmetic' },
      { key: 'description', required: 'cosmetic' },
      { key: 'annotations', required: 'full' },
      { key: 'pinnedArguments', required: 'full' },
      { key: 'defaultArguments', required: 'full' },
      { key: 'inputSchemaPatch', required: 'full' },
      { key: 'outputTransform', required: 'full' },
      { key: 'meta', required: 'full' },
      { key: 'timeoutMs', required: 'full' },
    ],
    level,
    base,
    rejected,
  );
  if (out.annotations) {
    const safe = filterAnnotations(out.annotations, `${base}/annotations`, rejected);
    if (isEmpty(safe)) delete out.annotations;
    else out.annotations = safe;
  }
  if (tool.guardProfileId !== undefined) {
    rejected.push({
      path: `${base}/guardProfileId`,
      reason: 'guardProfileId may only be set in the catalog layer (guards are a security control)',
    });
  }
  copyHidden(tool, out, level, base, rejected);
  return out;
};

/** `hidden: true` is cosmetic; `hidden: false` could undo an administrator's hiding. */
const copyHidden = (
  item: { hidden?: boolean | undefined },
  out: { hidden?: boolean | undefined },
  level: UserOverridesLevel,
  base: string,
  rejected: Rejection[],
): void => {
  if (item.hidden === undefined) return;
  if (!needs(level, 'cosmetic')) {
    rejected.push({ path: `${base}/hidden`, reason: levelReason('hidden', 'cosmetic', level) });
  } else if (item.hidden === false) {
    rejected.push({
      path: `${base}/hidden`,
      reason: 'hidden: false cannot be set in the installation layer; remove the entry instead',
    });
  } else out.hidden = true;
};

const filterPrompt = (
  prompt: PromptOverride,
  level: UserOverridesLevel,
  base: string,
  rejected: Rejection[],
): PromptOverride => {
  const out = filterFields<PromptOverride>(
    prompt,
    [
      { key: 'name', required: 'cosmetic' },
      { key: 'title', required: 'cosmetic' },
      { key: 'description', required: 'cosmetic' },
      { key: 'arguments', required: 'full' },
      { key: 'messagesTransform', required: 'full' },
    ],
    level,
    base,
    rejected,
  );
  copyHidden(prompt, out, level, base, rejected);
  return out;
};

const filterResource = (
  item: ResourceOverride,
  level: UserOverridesLevel,
  base: string,
  rejected: Rejection[],
): ResourceOverride => {
  const out = filterFields<ResourceOverride>(
    item,
    [
      { key: 'title', required: 'cosmetic' },
      { key: 'description', required: 'cosmetic' },
    ],
    level,
    base,
    rejected,
  );
  copyHidden(item, out, level, base, rejected);
  return out;
};

const filterTemplate = (
  item: ResourceTemplateOverride,
  level: UserOverridesLevel,
  base: string,
  rejected: Rejection[],
): ResourceTemplateOverride => {
  const out = filterFields<ResourceTemplateOverride>(
    item,
    [
      { key: 'title', required: 'cosmetic' },
      { key: 'description', required: 'cosmetic' },
      { key: 'pinnedVariables', required: 'full' },
    ],
    level,
    base,
    rejected,
  );
  copyHidden(item, out, level, base, rejected);
  return out;
};

const filterItems = <T extends object>(
  items: Readonly<Record<string, T>>,
  section: string,
  fn: (item: T, base: string) => T,
): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(items)) {
    const kept = fn(item, `/${section}/${seg(key)}`);
    if (!isEmpty(kept)) out[key] = kept;
  }
  return out;
};

/**
 * Strips from an installation-layer document what its author may not set (12.1) and reports each
 * removal. Cosmetic: hide, name, title, description (and instructions). Full: also arguments,
 * schema patches, output transforms, meta, annotations, timeouts, `uriPrefix`. Safer-looking
 * annotations and `guardProfileId` are catalog-only at every level.
 */
export const filterUserLayer = (
  doc: OverridesDocument,
  level: UserOverridesLevel,
): FilterResult => {
  const rejected: Rejection[] = [];
  const out: OverridesDocument = {
    version: 1,
    tools: filterItems(doc.tools, 'tools', (t, base) => filterTool(t, level, base, rejected)),
    prompts: filterItems(doc.prompts, 'prompts', (p, base) =>
      filterPrompt(p, level, base, rejected),
    ),
    resources: filterItems(doc.resources, 'resources', (r, base) =>
      filterResource(r, level, base, rejected),
    ),
    resourceTemplates: filterItems(doc.resourceTemplates, 'resourceTemplates', (r, base) =>
      filterTemplate(r, level, base, rejected),
    ),
  };
  if (doc.instructions !== undefined) {
    if (needs(level, 'cosmetic')) out.instructions = doc.instructions;
    else
      rejected.push({
        path: '/instructions',
        reason: levelReason('instructions', 'cosmetic', level),
      });
  }
  if (doc.uriPrefix !== undefined) {
    if (needs(level, 'full')) out.uriPrefix = doc.uriPrefix;
    else rejected.push({ path: '/uriPrefix', reason: levelReason('uriPrefix', 'full', level) });
  }
  return { doc: out, rejected };
};
