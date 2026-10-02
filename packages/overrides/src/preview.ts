/**
 * Preview for `POST /api/v1/overrides/preview` (17.2, 12.5): final definitions and a structured diff
 * of upstream versus final, per item, for an unsaved document.
 */
import type { TemplateContext } from '@bastion-mcp/core';
import { compare, getValueByPointer } from 'fast-json-patch';
import {
  applyInstructions,
  applyToPrompt,
  applyToResource,
  applyToResourceTemplate,
  applyToTool,
} from './apply';
import type {
  FinalPrompt,
  FinalResource,
  FinalResourceTemplate,
  FinalTool,
  HiddenItem,
  InvalidItem,
  OverrideIssue,
  OverrideLayers,
  UpstreamPrompt,
  UpstreamResource,
  UpstreamResourceTemplate,
  UpstreamTool,
} from './types';

export type UpstreamDefinitions = {
  instructions?: string;
  tools?: UpstreamTool[];
  prompts?: UpstreamPrompt[];
  resources?: UpstreamResource[];
  resourceTemplates?: UpstreamResourceTemplate[];
};

export type DiffChange = {
  /** JSON Pointer into the definition, e.g. `/description` or `/inputSchema/properties/owner`. */
  path: string;
  op: 'add' | 'remove' | 'replace';
  before?: unknown;
  after?: unknown;
};

export type ItemKind = 'tool' | 'prompt' | 'resource' | 'resourceTemplate';

export type ItemDiff = {
  kind: ItemKind;
  /** Upstream name (or URI / URI template). */
  key: string;
  status: 'unchanged' | 'modified' | 'hidden' | 'invalid';
  /** Present for invalid items and for tools whose schema patch was not applied. */
  error?: string;
  issues: OverrideIssue[];
  changes: DiffChange[];
};

export type PreviewResult = {
  final: {
    instructions?: string;
    tools: FinalTool[];
    prompts: FinalPrompt[];
    resources: FinalResource[];
    resourceTemplates: FinalResourceTemplate[];
    /** Hidden and withheld items, so the editor can still list them. */
    hidden: { kind: ItemKind; key: string }[];
    invalid: { kind: ItemKind; key: string; error: string }[];
  };
  instructions?: { before?: string; after?: string };
  diff: ItemDiff[];
};

const isHidden = (r: { kind: string }): r is HiddenItem => r.kind === 'hidden';
const isInvalid = (r: { kind: string }): r is InvalidItem => r.kind === 'invalid';

const changesBetween = (before: object, after: object): DiffChange[] =>
  compare(before, after).flatMap((op): DiffChange[] => {
    if (op.op === 'add') return [{ path: op.path, op: 'add', after: op.value }];
    if (op.op === 'remove') {
      return [{ path: op.path, op: 'remove', before: getValueByPointer(before, op.path) }];
    }
    if (op.op === 'replace') {
      return [
        {
          path: op.path,
          op: 'replace',
          before: getValueByPointer(before, op.path),
          after: op.value,
        },
      ];
    }
    return [];
  });

/**
 * Applies the layers to every upstream definition and returns the final definitions with a diff
 * per item. Names are the exact override names only; prefixing is the router's job (7.3).
 */
export const previewOverrides = (
  upstream: UpstreamDefinitions,
  layers: OverrideLayers,
  options: { installationSlug?: string; templateContext?: TemplateContext } = {},
): PreviewResult => {
  const resOptions = {
    installationSlug: options.installationSlug ?? 'installation',
    ...(options.templateContext ? { templateContext: options.templateContext } : {}),
  };
  const final: PreviewResult['final'] = {
    tools: [],
    prompts: [],
    resources: [],
    resourceTemplates: [],
    hidden: [],
    invalid: [],
  };
  const diff: ItemDiff[] = [];

  const record = <D extends object, F extends { kind: string; issues: OverrideIssue[] }>(
    kind: ItemKind,
    key: string,
    before: D,
    result: F | HiddenItem | InvalidItem,
    definition: (f: F) => D,
    push: (f: F) => void,
  ): void => {
    if (isHidden(result)) {
      final.hidden.push({ kind, key });
      diff.push({ kind, key, status: 'hidden', issues: [], changes: [] });
      return;
    }
    if (isInvalid(result)) {
      final.invalid.push({ kind, key, error: result.error });
      diff.push({
        kind,
        key,
        status: 'invalid',
        error: result.error,
        issues: result.issues,
        changes: [],
      });
      return;
    }
    const item = result as F;
    push(item);
    const changes = changesBetween(before, definition(item));
    const patchError = (item as { invalid?: { error: string } }).invalid?.error;
    diff.push({
      kind,
      key,
      status: changes.length > 0 ? 'modified' : 'unchanged',
      ...(patchError === undefined ? {} : { error: patchError }),
      issues: item.issues,
      changes,
    });
  };

  for (const tool of upstream.tools ?? []) {
    record(
      'tool',
      tool.name,
      tool,
      applyToTool(tool, layers),
      (f) => f.tool,
      (f) => final.tools.push(f),
    );
  }
  for (const prompt of upstream.prompts ?? []) {
    record(
      'prompt',
      prompt.name,
      prompt,
      applyToPrompt(prompt, layers),
      (f) => f.prompt,
      (f) => final.prompts.push(f),
    );
  }
  for (const resource of upstream.resources ?? []) {
    record(
      'resource',
      resource.uri,
      resource,
      applyToResource(resource, layers, resOptions),
      (f) => f.resource,
      (f) => final.resources.push(f),
    );
  }
  for (const template of upstream.resourceTemplates ?? []) {
    record(
      'resourceTemplate',
      template.uriTemplate,
      template,
      applyToResourceTemplate(template, layers, resOptions),
      (f) => f.template,
      (f) => final.resourceTemplates.push(f),
    );
  }

  const result: PreviewResult = { final, diff };
  const instructions = applyInstructions(upstream.instructions, layers);
  if (instructions !== undefined) {
    final.instructions = instructions;
    result.instructions = {
      ...(upstream.instructions === undefined ? {} : { before: upstream.instructions }),
      after: instructions,
    };
  }
  return result;
};
