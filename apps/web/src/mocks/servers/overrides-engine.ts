/**
 * A small stand-in for `@bastion-mcp/overrides` (12): applies the cosmetic parts of an override document (name, title,
 * description, annotations, hidden) to upstream definitions and reports what changed in the shape the real preview
 * returns (`OverridePreview`). Pinned arguments, schema patches and output transforms are validated by the real API;
 * the mock accepts and ignores them.
 */
import type { Definitions, OverridePreview } from '@/api/views/servers';
import type { CapabilityItem } from './definitions';

type Json = Record<string, unknown>;
type Change = OverridePreview['diff'][number]['changes'][number];
type Kind = OverridePreview['diff'][number]['kind'];

export type Upstream = {
  tools: Json[];
  prompts: Json[];
  resources: Json[];
  resourceTemplates: Json[];
};

/** MCP definitions of an entry's items, as a server would list them. */
export const toUpstream = (items: readonly CapabilityItem[]): Upstream => ({
  tools: items
    .filter((i) => i.kind === 'tool')
    .map((i) => ({
      name: i.name,
      description: i.description,
      inputSchema: i.inputSchema ?? { type: 'object', properties: { query: { type: 'string' } } },
      annotations: {
        readOnlyHint: i.access === 'read',
        destructiveHint: i.access === 'destructive',
      },
    })),
  prompts: items
    .filter((i) => i.kind === 'prompt')
    .map((i) => ({
      name: i.name,
      description: i.description,
      ...(i.arguments ? { arguments: i.arguments } : {}),
    })),
  resources: items
    .filter((i) => i.kind === 'resource')
    .map((i) => ({
      uri: i.uri ?? `mock://${i.name}`,
      name: i.name,
      description: i.description,
      mimeType: 'text/plain',
    })),
  resourceTemplates: items
    .filter((i) => i.kind === 'template')
    .map((i) => ({ uriTemplate: i.name, name: i.name, description: i.description })),
});

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** JSON-pointer changes from `before` to `after` (objects recurse, everything else replaces). */
const changesBetween = (before: unknown, after: unknown, path = ''): Change[] => {
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => {
      const p = `${path}/${esc(k)}`;
      if (!(k in before)) return [{ path: p, op: 'add' as const, after: after[k] }];
      if (!(k in after)) return [{ path: p, op: 'remove' as const, before: before[k] }];
      return changesBetween(before[k], after[k], p);
    });
  }
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [{ path, op: 'replace' as const, before, after }];
};

/** `applyText` of `@bastion-mcp/overrides`: replace by default; append and prepend join with a newline. */
const describe = (current: unknown, override: unknown): string | undefined => {
  const base = typeof current === 'string' ? current : '';
  if (typeof override === 'string') return override;
  if (isObject(override) && typeof override.text === 'string') {
    if (override.mode === 'replace' || !base) return override.text;
    if (override.mode === 'append') return `${base}\n${override.text}`;
    if (override.mode === 'prepend') return `${override.text}\n${base}`;
    return override.text;
  }
  return undefined;
};

// --- which override entries apply to an item (12.3) ----------------------------------------------------------------

const isGlobKey = (key: string): boolean => /[*?[\]]/.test(key);

/** The glob subset the mock needs (`*` stays inside one path segment, `**` crosses them, `?` is one character). */
const globMatches = (pattern: string, subject: string): boolean => {
  const source = pattern
    .split(/(\*\*|\*|\?)/)
    .map((part) =>
      part === '**'
        ? '.*'
        : part === '*'
          ? '[^/]*'
          : part === '?'
            ? '[^/]'
            : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${source}$`).test(subject);
};

/** Entries whose key matches `subject`, in application order: globs short to long, the exact key last. */
const matchingEntries = (record: Json, subject: string): Json[] => {
  const globs = Object.keys(record)
    .filter((k) => k !== subject && isGlobKey(k) && globMatches(k, subject))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const keys = subject in record ? [...globs, subject] : globs;
  return keys.map((k) => record[k]).filter(isObject);
};

/** `b` over `a`, field by field: a field `b` defines wins; annotations merge hint by hint (`mergeToolOverride`). */
const mergeOverride = (a: Json, b: Json): Json => {
  const merged: Json = { ...a, ...b };
  if (isObject(a.annotations) && isObject(b.annotations)) {
    merged.annotations = { ...a.annotations, ...b.annotations };
  }
  return merged;
};

const foldLayer = (doc: Json | undefined, section: string, subject: string): Json => {
  const record = isObject(doc?.[section]) ? (doc[section] as Json) : {};
  return matchingEntries(record, subject).reduce<Json>(mergeOverride, {});
};

/** The override of one item: the installation layer over the catalog layer, once merged, applied once (12.3). */
const resolveOverride = (layers: readonly (Json | undefined)[], section: string, key: string) =>
  layers.reduce<Json>((acc, doc) => mergeOverride(acc, foldLayer(doc, section, key)), {});

type Applied =
  | { status: 'hidden' }
  | { status: 'ok'; final: Json; overridden: boolean; renamed: boolean };

/** The catalog layer first, then the installation layer on top (12.1). */
const apply = (
  upstream: Json,
  section: string,
  key: string,
  layers: readonly (Json | undefined)[],
): Applied => {
  const ov = resolveOverride(layers, section, key);
  if (ov.hidden === true) return { status: 'hidden' };
  let final: Json = { ...upstream };
  if (typeof ov.title === 'string') final = { ...final, title: ov.title };
  const text = describe(final.description, ov.description);
  if (text !== undefined) final = { ...final, description: text };
  if (isObject(ov.annotations)) {
    final = {
      ...final,
      annotations: { ...(isObject(final.annotations) ? final.annotations : {}), ...ov.annotations },
    };
  }
  if (typeof ov.name === 'string') final = { ...final, name: ov.name };
  const changes = changesBetween(upstream, final);
  return {
    status: 'ok',
    final,
    overridden: changes.length > 0,
    renamed: final.name !== upstream.name,
  };
};

const SECTIONS = [
  ['tool', 'tools', 'tools', 'name'],
  ['prompt', 'prompts', 'prompts', 'name'],
  ['resource', 'resources', 'resources', 'uri'],
  ['resourceTemplate', 'resourceTemplates', 'resourceTemplates', 'uriTemplate'],
] as const satisfies readonly (readonly [Kind, keyof Upstream, string, string])[];

const keyOf = (def: Json, field: string): string => String(def[field] ?? '');

/** Items written in the override documents (`added`): the later layer wins per key. */
const addedOf = (layers: readonly (Json | undefined)[], section: string): Record<string, Json> => {
  let out: Record<string, Json> = {};
  for (const doc of layers) {
    const added = isObject(doc?.added) ? (doc.added as Json) : {};
    const items = added[section];
    if (isObject(items)) out = { ...out, ...(items as Record<string, Json>) };
  }
  return out;
};

const hostedDefinition = (kind: Kind, key: string, def: Json): Json =>
  kind === 'prompt'
    ? {
        name: key,
        ...(def.title === undefined ? {} : { title: def.title }),
        ...(def.description === undefined ? {} : { description: def.description }),
        ...(def.arguments === undefined ? {} : { arguments: def.arguments }),
      }
    : {
        [kind === 'resource' ? 'uri' : 'uriTemplate']: key,
        name: def.name,
        ...(def.title === undefined ? {} : { title: def.title }),
        ...(def.description === undefined ? {} : { description: def.description }),
        mimeType: def.mimeType ?? 'text/plain',
      };

/** The upstream listing with the added items in it (an upstream item with the same key gives way). */
const withAddedItems = (
  upstream: Upstream,
  kind: Kind,
  list: keyof Upstream,
  field: string,
  layers: readonly (Json | undefined)[],
): { defs: Json[]; added: Set<string> } => {
  if (kind === 'tool') return { defs: upstream[list], added: new Set() };
  const section =
    kind === 'prompt' ? 'prompts' : kind === 'resource' ? 'resources' : 'resourceTemplates';
  const added = addedOf(layers, section);
  const keys = Object.keys(added);
  return {
    defs: [
      ...upstream[list].filter((d) => !keys.includes(keyOf(d, field))),
      ...keys.map((k) => hostedDefinition(kind, k, added[k] as Json)),
    ],
    added: new Set(keys),
  };
};

/** What `GET /installations/{id}/tools|prompts|resources|templates` answers for one kind. */
export const definitionsFor = (
  kind: Kind,
  upstream: Upstream,
  layers: readonly (Json | undefined)[],
  needsAuth: string | null,
): Definitions => {
  const [, list, section, field] = SECTIONS.find((s) => s[0] === kind) ?? SECTIONS[0];
  const items: Definitions['items'] = [];
  const meta: Definitions['meta'] = [];
  for (const def of withAddedItems(upstream, kind, list, field, layers).defs) {
    const key = keyOf(def, field);
    const r = apply(def, section, key, layers);
    if (r.status === 'hidden') continue;
    items.push(r.final);
    meta.push({
      kind,
      installationId: '',
      upstreamKey: key,
      finalKey: keyOf(r.final, field),
      overridden: r.overridden,
      renamed: r.renamed,
      collided: false,
      issues: [],
    });
  }
  return {
    items,
    meta,
    degraded: [],
    needsAuth: needsAuth ? [{ installation: needsAuth }] : [],
    warnings: [],
  };
};

/** What `POST /overrides/preview` answers for an unsaved installation-layer document. */
export const previewFor = (
  upstream: Upstream,
  catalogLayer: Json | undefined,
  doc: Json,
): OverridePreview => {
  const final: OverridePreview['final'] = {
    tools: [],
    prompts: [],
    resources: [],
    resourceTemplates: [],
    hidden: [],
    invalid: [],
  };
  const diff: OverridePreview['diff'] = [];
  for (const [kind, list, section, field] of SECTIONS) {
    const listing = withAddedItems(upstream, kind, list, field, [catalogLayer, doc]);
    for (const def of listing.defs) {
      const key = keyOf(def, field);
      const mark = listing.added.has(key) ? { added: true as const } : {};
      const r = apply(def, section, key, [catalogLayer, doc]);
      if (r.status === 'hidden') {
        final.hidden.push({ kind, key });
        diff.push({ kind, key, status: 'hidden', ...mark, issues: [], changes: [] });
        continue;
      }
      const changes = changesBetween(def, r.final);
      diff.push({
        kind,
        key,
        status: changes.length ? 'modified' : 'unchanged',
        ...mark,
        issues: [],
        changes,
      });
      if (kind === 'tool') final.tools.push({ upstreamName: key, tool: r.final });
      else if (kind === 'prompt') final.prompts.push({ upstreamName: key, prompt: r.final });
      else if (kind === 'resource') final.resources.push({ upstreamUri: key, resource: r.final });
      else final.resourceTemplates.push({ upstreamTemplate: key, template: r.final });
    }
  }
  return { final, diff, rejected: [] };
};

/** Why an override document would be refused (the real API answers 400 with these pointers). */
export const documentErrors = (doc: Json): { path: string; message: string }[] => {
  const errors: { path: string; message: string }[] = [];
  if (doc.version !== undefined && doc.version !== 1) {
    errors.push({ path: 'version', message: 'Invalid input: expected 1' });
  }
  for (const [section, items] of Object.entries(doc)) {
    if (
      !['tools', 'prompts', 'resources', 'resourceTemplates'].includes(section) ||
      !isObject(items)
    )
      continue;
    for (const [key, ov] of Object.entries(items)) {
      if (isObject(ov) && typeof ov.name === 'string' && !/^[A-Za-z0-9_.-]{1,128}$/.test(ov.name)) {
        errors.push({
          path: `${section}.${key}.name`,
          message: 'must match ^[A-Za-z0-9_.-]{1,128}$',
        });
      }
    }
  }
  return errors;
};
