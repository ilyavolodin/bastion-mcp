/**
 * Applying override layers to upstream definitions (12.3). Pure: definitions in, final definitions
 * and call-time plans out. Invalid overrides never throw; they are reported on the result.
 */
import {
  resolveTemplate,
  type TemplateContext,
  TemplateError,
  validateTemplate,
} from '@bastion-mcp/core';
import { applyPatch, type Operation } from 'fast-json-patch';
import {
  resolvePromptOverride,
  resolveResourceOverride,
  resolveResourceTemplateOverride,
  resolveToolOverride,
} from './resolve';
import type {
  DescriptionOverride,
  InstructionsOverride,
  JsonObject,
  JsonValue,
  MetaOverride,
} from './schema';
import { compileSchema, isObject, validateXMcpHeaders } from './schema-tools';
import type {
  ApplyResult,
  FinalPrompt,
  FinalResource,
  FinalResourceTemplate,
  FinalTool,
  InvalidItem,
  OverrideIssue,
  OverrideLayers,
  UpstreamPrompt,
  UpstreamPromptArgument,
  UpstreamResource,
  UpstreamResourceTemplate,
  UpstreamTool,
} from './types';
import { addUriPrefix, pinTemplateVariables } from './uri';

/** Keys under this prefix belong to the MCP extensions framework and cannot be removed (12.3, 6.8). */
export const PROTECTED_META_PREFIX = 'io.modelcontextprotocol/';
/** MCP Apps metadata passes through unchanged (6.8). */
export const PROTECTED_META_KEYS: readonly string[] = ['ui'];

const clone = <T>(value: T): T => structuredClone(value);

/** Replace by default; append and prepend join with a newline. */
export const applyText = (upstream: string | undefined, override: DescriptionOverride): string => {
  if (typeof override === 'string') return override;
  if (override.mode === 'replace' || upstream === undefined || upstream === '')
    return override.text;
  return override.mode === 'append'
    ? `${upstream}\n${override.text}`
    : `${override.text}\n${upstream}`;
};

const invalid = (error: string, issues: OverrideIssue[]): InvalidItem => ({
  kind: 'invalid',
  degraded: true,
  error,
  issues,
});

const templateStrings = (value: JsonValue): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(templateStrings);
  if (isObject(value)) return Object.values(value).flatMap(templateStrings);
  return [];
};

/** Returns the first template error in the given values, if any. */
const templateError = (values: readonly JsonValue[]): string | undefined => {
  for (const text of values.flatMap(templateStrings)) {
    try {
      validateTemplate(text);
    } catch (error) {
      if (error instanceof TemplateError) return error.message;
      throw error;
    }
  }
  return undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Removes `keys` from `properties` and `required`; returns the keys that were present. */
const removeProperties = (schema: JsonObject, keys: readonly string[]): string[] => {
  const present: string[] = [];
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  for (const key of keys) {
    if (properties && key in properties) {
      present.push(key);
      delete properties[key];
    }
  }
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((r) => typeof r !== 'string' || !keys.includes(r));
    if (required.length > 0) schema.required = required;
    else delete schema.required;
  }
  return present;
};

const applyMeta = (
  meta: Record<string, unknown> | undefined,
  override: MetaOverride | undefined,
  issues: OverrideIssue[],
): Record<string, unknown> | undefined => {
  if (!override) return meta;
  const out: Record<string, unknown> = { ...(meta ?? {}) };
  for (const key of override.remove ?? []) {
    if (key.startsWith(PROTECTED_META_PREFIX) || PROTECTED_META_KEYS.includes(key)) {
      issues.push({
        code: 'meta_remove_forbidden',
        message: `_meta key "${key}" cannot be removed: keys under ${PROTECTED_META_PREFIX} and MCP Apps "ui" pass through`,
        path: `/meta/remove/${key}`,
      });
    } else delete out[key];
  }
  for (const [key, value] of Object.entries(override.set ?? {})) {
    if (PROTECTED_META_KEYS.includes(key)) {
      issues.push({
        code: 'meta_set_forbidden',
        message: `_meta key "${key}" (MCP Apps) passes through unchanged and cannot be set`,
        path: `/meta/set/${key}`,
      });
    } else out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
};

/**
 * Applies the layered override to one upstream tool (12.3): hidden; name; title and description;
 * pinning; defaults; the JSON Patch (after pinning, checked against 2020-12); annotations; `_meta`;
 * `x-mcp-header` validation. An invalid patch is reported and skipped; the tool is otherwise served.
 */
export const applyToTool = (
  upstream: UpstreamTool,
  layers: OverrideLayers,
): ApplyResult<FinalTool> => {
  const ov = resolveToolOverride(layers, upstream.name);
  if (ov.hidden === true) return { kind: 'hidden' };
  const issues: OverrideIssue[] = [];

  const pinned: Record<string, JsonValue> = { ...(ov.pinnedArguments ?? {}) };
  const tplError = templateError(Object.values(pinned));
  if (tplError !== undefined) {
    return invalid(`pinned argument template: ${tplError}`, [
      { code: 'invalid_template', message: tplError, path: '/pinnedArguments' },
    ]);
  }
  const pinnedKeys = Object.keys(pinned);

  const tool = clone(upstream);
  let schema: JsonObject = isObject(tool.inputSchema) ? tool.inputSchema : { type: 'object' };

  // 1. Pinning: properties and required lose the pinned arguments.
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const droppedHeaders = pinnedKeys.filter((k) => {
    const prop = properties?.[k];
    return isObject(prop) && prop['x-mcp-header'] !== undefined;
  });
  for (const key of droppedHeaders) {
    issues.push({
      code: 'x_mcp_header_dropped',
      message: `x-mcp-header on pinned property "${key}" was dropped with the property`,
      path: `/inputSchema/properties/${key}`,
    });
  }
  removeProperties(schema, pinnedKeys);

  // 2. Defaults: `default` in the schema for the remaining properties.
  const defaults: Record<string, JsonValue> = {};
  const props = isObject(schema.properties) ? schema.properties : undefined;
  for (const [key, value] of Object.entries(ov.defaultArguments ?? {})) {
    if (key in pinned) continue;
    const prop = props?.[key];
    if (props && isObject(prop)) {
      props[key] = { ...prop, default: value };
      defaults[key] = value;
    } else if (props && prop === undefined) {
      issues.push({
        code: 'default_for_unknown_property',
        message: `defaultArguments.${key} ignored: the input schema has no such property`,
        path: `/defaultArguments/${key}`,
      });
    }
  }

  // 3. Patch (RFC 6902), then must compile as JSON Schema 2020-12.
  let invalidPatch: FinalTool['invalid'];
  let patchApplied = false;
  const patch = ov.inputSchemaPatch ?? [];
  if (patch.length > 0) {
    try {
      const patched = applyPatch(clone(schema), clone(patch) as Operation[], true, false)
        .newDocument as unknown;
      if (!isObject(patched)) throw new Error('patched input schema is not an object');
      compileSchema(patched);
      schema = patched;
      patchApplied = true;
      const readded = removeProperties(schema, pinnedKeys);
      for (const key of readded) {
        issues.push({
          code: 'patch_readded_pinned_property',
          message: `inputSchemaPatch re-added pinned property "${key}"; it was removed again`,
          path: `/inputSchema/properties/${key}`,
        });
      }
    } catch (error) {
      invalidPatch = { field: 'inputSchemaPatch', error: errorMessage(error) };
    }
  }

  // 4. x-mcp-header rules; any problem withholds the tool.
  const headerErrors = validateXMcpHeaders(schema);
  if (headerErrors.length > 0) {
    return invalid(`x-mcp-header: ${headerErrors.join('; ')}`, [
      ...issues,
      ...headerErrors.map((message) => ({ code: 'invalid_x_mcp_header', message })),
    ]);
  }

  // 5. Presentation: name, title, description, annotations, _meta.
  tool.inputSchema = schema;
  if (ov.title !== undefined) tool.title = ov.title;
  if (ov.description !== undefined) tool.description = applyText(tool.description, ov.description);
  if (ov.annotations) tool.annotations = { ...(tool.annotations ?? {}), ...ov.annotations };
  const meta = applyMeta(tool._meta, ov.meta, issues);
  if (meta === undefined) delete tool._meta;
  else tool._meta = meta;
  if (ov.name !== undefined) tool.name = ov.name;

  const validate = pinnedKeys.length > 0 || patchApplied;
  const result: FinalTool = {
    kind: 'tool',
    upstreamName: upstream.name,
    tool,
    plan: { upstreamName: upstream.name, pinned, defaults, schema, validate },
    issues,
  };
  if (ov.name !== undefined) result.exactName = ov.name;
  if (ov.outputTransform) result.plan.outputTransform = ov.outputTransform;
  if (ov.timeoutMs !== undefined) result.plan.timeoutMs = ov.timeoutMs;
  if (ov.guardProfileId !== undefined) result.plan.guardProfileId = ov.guardProfileId;
  if (invalidPatch) result.invalid = invalidPatch;
  return result;
};

/** Prompts (12.3): argument pinning and hiding, `messagesTransform`, name, title, description. */
export const applyToPrompt = (
  upstream: UpstreamPrompt,
  layers: OverrideLayers,
): ApplyResult<FinalPrompt> => {
  const ov = resolvePromptOverride(layers, upstream.name);
  if (ov.hidden === true) return { kind: 'hidden' };
  const issues: OverrideIssue[] = [];

  const pinned: Record<string, string> = {};
  const hidden: string[] = [];
  for (const [name, arg] of Object.entries(ov.arguments ?? {})) {
    if (arg.pinned !== undefined) pinned[name] = arg.pinned;
    else if (arg.hidden === true) hidden.push(name);
  }
  const tplError = templateError(Object.values(pinned));
  if (tplError !== undefined) {
    return invalid(`pinned prompt argument template: ${tplError}`, [
      { code: 'invalid_template', message: tplError, path: '/arguments' },
    ]);
  }

  const prompt = clone(upstream);
  if (prompt.arguments) {
    const kept: UpstreamPromptArgument[] = [];
    for (const arg of prompt.arguments) {
      if (arg.name in pinned) continue;
      if (hidden.includes(arg.name)) {
        if (arg.required === true) {
          issues.push({
            code: 'hidden_required_argument',
            message: `argument "${arg.name}" is required and stays visible; pin it to fix its value`,
            path: `/arguments/${arg.name}/hidden`,
          });
          hidden.splice(hidden.indexOf(arg.name), 1);
        } else continue;
      }
      kept.push(arg);
    }
    prompt.arguments = kept;
  }
  if (ov.title !== undefined) prompt.title = ov.title;
  if (ov.description !== undefined)
    prompt.description = applyText(prompt.description, ov.description);
  if (ov.name !== undefined) prompt.name = ov.name;

  const result: FinalPrompt = {
    kind: 'prompt',
    upstreamName: upstream.name,
    prompt,
    plan: { upstreamName: upstream.name, pinned, hidden },
    issues,
  };
  if (ov.name !== undefined) result.exactName = ov.name;
  if (ov.messagesTransform) result.plan.messagesTransform = ov.messagesTransform;
  return result;
};

export type ResourceApplyOptions = {
  installationSlug: string;
  /** Resolves value templates in `pinnedVariables`. */
  templateContext?: TemplateContext;
};

const wantsPrefix = (layers: OverrideLayers): boolean =>
  (layers.installation?.uriPrefix ?? layers.catalog?.uriPrefix) === true;

/** Resources (12.3, 7.4): hidden, title, description and the `bastion+{slug}:` prefix. */
export const applyToResource = (
  upstream: UpstreamResource,
  layers: OverrideLayers,
  options: ResourceApplyOptions,
): ApplyResult<FinalResource> => {
  const ov = resolveResourceOverride(layers, upstream.uri);
  if (ov.hidden === true) return { kind: 'hidden' };
  const resource = clone(upstream);
  if (ov.title !== undefined) resource.title = ov.title;
  if (ov.description !== undefined) {
    resource.description = applyText(resource.description, ov.description);
  }
  const prefix = wantsPrefix(layers);
  if (prefix) resource.uri = addUriPrefix(options.installationSlug, upstream.uri);
  return {
    kind: 'resource',
    upstreamUri: upstream.uri,
    resource,
    route: prefix
      ? { kind: 'resource', prefixSlug: options.installationSlug }
      : { kind: 'resource' },
    issues: [],
  };
};

/** Resource templates (12.3): `pinnedVariables` substituted into the advertised template. */
export const applyToResourceTemplate = (
  upstream: UpstreamResourceTemplate,
  layers: OverrideLayers,
  options: ResourceApplyOptions,
): ApplyResult<FinalResourceTemplate> => {
  const ov = resolveResourceTemplateOverride(layers, upstream.uriTemplate);
  if (ov.hidden === true) return { kind: 'hidden' };
  const issues: OverrideIssue[] = [];

  const pinnedVariables: Record<string, string> = {};
  for (const [name, raw] of Object.entries(ov.pinnedVariables ?? {})) {
    try {
      pinnedVariables[name] = resolveValue(raw, options.templateContext);
    } catch (error) {
      return invalid(`pinned variable "${name}": ${errorMessage(error)}`, [
        {
          code: 'invalid_template',
          message: errorMessage(error),
          path: `/pinnedVariables/${name}`,
        },
      ]);
    }
  }
  const pinned = pinTemplateVariables(upstream.uriTemplate, pinnedVariables);
  if (!pinned.ok) {
    return invalid(pinned.error, [{ code: 'unsupported_pinned_variable', message: pinned.error }]);
  }

  const template = clone(upstream);
  template.uriTemplate = pinned.template;
  if (ov.title !== undefined) template.title = ov.title;
  if (ov.description !== undefined) {
    template.description = applyText(template.description, ov.description);
  }
  const prefix = wantsPrefix(layers);
  if (prefix) template.uriTemplate = addUriPrefix(options.installationSlug, template.uriTemplate);
  return {
    kind: 'resourceTemplate',
    upstreamTemplate: upstream.uriTemplate,
    template,
    route: {
      kind: 'template',
      upstreamTemplate: upstream.uriTemplate,
      pinnedVariables,
      ...(prefix ? { prefixSlug: options.installationSlug } : {}),
    },
    issues,
  };
};

const resolveValue = (raw: string, ctx: TemplateContext | undefined): string => {
  validateTemplate(raw);
  return resolveTemplateString(raw, ctx);
};

const resolveTemplateString = (raw: string, ctx: TemplateContext | undefined): string =>
  raw.includes('{{') ? resolveTemplate(raw, ctx ?? {}) : raw;

/** Instructions (12.3): replace or append to the upstream `instructions` for this installation. */
export const applyInstructions = (
  upstream: string | undefined,
  layers: OverrideLayers,
): string | undefined => {
  const ov: InstructionsOverride | undefined =
    layers.installation?.instructions ?? layers.catalog?.instructions;
  if (!ov) return upstream;
  if (ov.mode === 'replace' || upstream === undefined || upstream === '') return ov.text;
  return `${upstream}\n${ov.text}`;
};
