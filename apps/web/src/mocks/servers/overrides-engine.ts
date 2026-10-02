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
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      annotations: {
        readOnlyHint: i.access === 'read',
        destructiveHint: i.access === 'destructive',
      },
    })),
  prompts: items
    .filter((i) => i.kind === 'prompt')
    .map((i) => ({ name: i.name, description: i.description })),
  resources: [],
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

const describe = (current: unknown, override: unknown): string | undefined => {
  const base = typeof current === 'string' ? current : '';
  if (typeof override === 'string') return override;
  if (isObject(override) && typeof override.text === 'string') {
    if (override.mode === 'append') return base ? `${base}\n\n${override.text}` : override.text;
    if (override.mode === 'prepend') return base ? `${override.text}\n\n${base}` : override.text;
    return override.text;
  }
  return undefined;
};

const layerOf = (doc: Json | undefined, section: string, key: string): Json =>
  isObject(doc?.[section]) && isObject((doc[section] as Json)[key])
    ? ((doc[section] as Json)[key] as Json)
    : {};

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
  let final: Json = { ...upstream };
  for (const doc of layers) {
    const ov = layerOf(doc, section, key);
    if (ov.hidden === true) return { status: 'hidden' };
    if (typeof ov.name === 'string') final = { ...final, name: ov.name };
    if (typeof ov.title === 'string') final = { ...final, title: ov.title };
    const text = describe(final.description, ov.description);
    if (text !== undefined) final = { ...final, description: text };
    if (isObject(ov.annotations)) {
      final = {
        ...final,
        annotations: {
          ...(isObject(final.annotations) ? final.annotations : {}),
          ...ov.annotations,
        },
      };
    }
  }
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
  for (const def of upstream[list]) {
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
    for (const def of upstream[list]) {
      const key = keyOf(def, field);
      const r = apply(def, section, key, [catalogLayer, doc]);
      if (r.status === 'hidden') {
        final.hidden.push({ kind, key });
        diff.push({ kind, key, status: 'hidden', issues: [], changes: [] });
        continue;
      }
      const changes = changesBetween(def, r.final);
      diff.push({
        kind,
        key,
        status: changes.length ? 'modified' : 'unchanged',
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
