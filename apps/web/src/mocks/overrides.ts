/** A small stand-in for the server's override compiler (12.3), enough for the editor preview mock. */
import type {
  CapabilityItem,
  DefinitionPair,
  EffectiveCapability,
  OverrideDocument,
} from '@/api/types';

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

export const findOverride = (
  map: Record<string, Record<string, unknown>> | undefined,
  name: string,
): Record<string, unknown> | undefined => {
  if (!map) return undefined;
  const exact = map[name];
  if (exact) return exact;
  const globs = Object.keys(map)
    .filter((k) => k.includes('*') || k.includes('?'))
    .sort((a, b) => a.length - b.length);
  let merged: Record<string, unknown> | undefined;
  for (const g of globs) if (globToRegExp(g).test(name)) merged = { ...merged, ...map[g] };
  return merged;
};

const mapFor = (doc: OverrideDocument, kind: CapabilityItem['kind']) =>
  kind === 'tool'
    ? doc.tools
    : kind === 'prompt'
      ? doc.prompts
      : kind === 'resource'
        ? doc.resources
        : doc.resourceTemplates;

const GUARDED = /write|delete|run_query|post|create|fetch/;

export const applyToCapability = (item: CapabilityItem, doc: OverrideDocument): EffectiveCapability => {
  const ov = findOverride(mapFor(doc, item.kind), item.name);
  const hidden = ov?.hidden === true;
  const keys = ov ? Object.keys(ov).filter((k) => k !== 'hidden') : [];
  const d = ov?.description;
  const description =
    typeof d === 'string'
      ? d
      : d && typeof d === 'object'
        ? applyText(item.description, d as { mode: string; text: string })
        : item.description;
  return {
    ...item,
    description,
    finalName: typeof ov?.name === 'string' ? ov.name : item.name,
    overridden: keys.length > 0,
    hidden,
    guarded: item.access === 'destructive' || GUARDED.test(item.name),
  };
};

const applyText = (base: string, o: { mode: string; text: string }): string =>
  o.mode === 'append' ? `${base} ${o.text}` : o.mode === 'prepend' ? `${o.text} ${base}` : o.text;

const upstreamDefinition = (item: CapabilityItem): Record<string, unknown> => ({
  name: item.name,
  description: item.description,
  inputSchema: {
    type: 'object',
    properties:
      item.kind === 'tool'
        ? { query: { type: 'string', description: 'What to look for' }, limit: { type: 'integer' } }
        : {},
    required: item.kind === 'tool' ? ['query'] : [],
  },
  annotations: {
    readOnlyHint: item.access === 'read',
    destructiveHint: item.access === 'destructive',
  },
});

export const previewDefinitions = (
  items: CapabilityItem[],
  doc: OverrideDocument,
): { definitions: DefinitionPair[]; errors: string[] } => {
  const errors: string[] = [];
  const definitions = items.map((item): DefinitionPair => {
    const upstream = upstreamDefinition(item);
    const ov = findOverride(mapFor(doc, item.kind), item.name);
    if (ov?.hidden === true) return { name: item.name, kind: item.kind, upstream, final: null, error: null };
    if (!ov) return { name: item.name, kind: item.kind, upstream, final: structuredClone(upstream), error: null };
    const final = structuredClone(upstream) as Record<string, unknown> & {
      inputSchema: { properties: Record<string, Record<string, unknown>>; required: string[] };
    };
    const eff = applyToCapability(item, doc);
    final.name = eff.finalName;
    final.description = eff.description;
    if (typeof ov.title === 'string') final.title = ov.title;
    if (ov.annotations && typeof ov.annotations === 'object') {
      final.annotations = { ...(final.annotations as object), ...(ov.annotations as object) };
    }
    const pinned = ov.pinnedArguments as Record<string, unknown> | undefined;
    for (const k of Object.keys(pinned ?? {})) {
      delete final.inputSchema.properties[k];
      final.inputSchema.required = final.inputSchema.required.filter((r) => r !== k);
    }
    const defaults = ov.defaultArguments as Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(defaults ?? {})) {
      const prop = final.inputSchema.properties[k];
      if (prop) prop.default = v;
    }
    if (typeof ov.name === 'string' && !/^[A-Za-z0-9_.-]{1,128}$/.test(ov.name)) {
      const message = `name "${ov.name}" must match ^[A-Za-z0-9_.-]{1,128}$`;
      errors.push(`${item.name}: ${message}`);
      return { name: item.name, kind: item.kind, upstream, final: null, error: message };
    }
    return { name: item.name, kind: item.kind, upstream, final, error: null };
  });
  return { definitions, errors };
};
