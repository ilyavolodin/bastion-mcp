/**
 * Items Bastion hosts itself (12.2 `added`): prompts, resources and resource templates written in the override
 * document. They are listed like upstream definitions (so hiding, titles, namespacing and policy visibility apply to
 * them as to any other item) and answered by Bastion instead of the upstream.
 */
import type {
  AddedItems,
  AddedPrompt,
  AddedResource,
  AddedResourceTemplate,
  JsonObject,
} from './schema';
import type {
  OverrideLayers,
  UpstreamPrompt,
  UpstreamResource,
  UpstreamResourceTemplate,
} from './types';
import { matchUriTemplate, templateVariables } from './uri';

export type MergedAdded = {
  prompts: Record<string, AddedPrompt>;
  resources: Record<string, AddedResource>;
  resourceTemplates: Record<string, AddedResourceTemplate>;
};

/** The catalog layer's items, then the installation layer's: the same name or URI in the installation layer wins. */
export const mergedAdded = (layers: OverrideLayers): MergedAdded => {
  const pick = (layer: AddedItems | undefined): MergedAdded => ({
    prompts: layer?.prompts ?? {},
    resources: layer?.resources ?? {},
    resourceTemplates: layer?.resourceTemplates ?? {},
  });
  const catalog = pick(layers.catalog?.added);
  const installation = pick(layers.installation?.added);
  return {
    prompts: { ...catalog.prompts, ...installation.prompts },
    resources: { ...catalog.resources, ...installation.resources },
    resourceTemplates: { ...catalog.resourceTemplates, ...installation.resourceTemplates },
  };
};

export const hasAdded = (added: MergedAdded): boolean =>
  Object.keys(added.prompts).length +
    Object.keys(added.resources).length +
    Object.keys(added.resourceTemplates).length >
  0;

type Listing = {
  prompts: UpstreamPrompt[];
  resources: UpstreamResource[];
  resourceTemplates: UpstreamResourceTemplate[];
};

const withoutNone = <T extends object>(entries: { [K in keyof T]: T[K] | undefined }): T => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out as T;
};

export const promptDefinition = (name: string, def: AddedPrompt): UpstreamPrompt =>
  withoutNone<UpstreamPrompt>({
    name,
    title: def.title,
    description: def.description,
    arguments: def.arguments?.map((a) =>
      withoutNone<NonNullable<UpstreamPrompt['arguments']>[number]>({
        name: a.name,
        description: a.description,
        required: a.required,
      }),
    ),
  });

export const resourceDefinition = (uri: string, def: AddedResource): UpstreamResource =>
  withoutNone<UpstreamResource>({
    uri,
    name: def.name,
    title: def.title,
    description: def.description,
    mimeType: def.mimeType ?? 'text/plain',
  });

export const templateDefinition = (
  uriTemplate: string,
  def: AddedResourceTemplate,
): UpstreamResourceTemplate =>
  withoutNone<UpstreamResourceTemplate>({
    uriTemplate,
    name: def.name,
    title: def.title,
    description: def.description,
    mimeType: def.mimeType ?? 'text/plain',
  });

/**
 * The listing with the added items in it. An upstream item with the same name, URI or template is replaced; with
 * nothing added the very same object comes back.
 */
export const withAdded = <T extends Listing>(items: T, layers: OverrideLayers): T => {
  const added = mergedAdded(layers);
  if (!hasAdded(added)) return items;
  return {
    ...items,
    prompts: [
      ...items.prompts.filter((p) => !(p.name in added.prompts)),
      ...Object.entries(added.prompts).map(([name, def]) => promptDefinition(name, def)),
    ],
    resources: [
      ...items.resources.filter((r) => !(r.uri in added.resources)),
      ...Object.entries(added.resources).map(([uri, def]) => resourceDefinition(uri, def)),
    ],
    resourceTemplates: [
      ...items.resourceTemplates.filter((t) => !(t.uriTemplate in added.resourceTemplates)),
      ...Object.entries(added.resourceTemplates).map(([tpl, def]) => templateDefinition(tpl, def)),
    ],
  };
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Replaces `{{name}}` for the declared names only; text that merely looks like a placeholder stays as written. */
const fill = (
  text: string,
  declared: ReadonlySet<string>,
  values: Record<string, string>,
): string =>
  text.replace(PLACEHOLDER, (whole, name: string) =>
    declared.has(name) ? (values[name] ?? '') : whole,
  );

export type HostedPromptResult = {
  description?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>;
};

/** `prompts/get` for an added prompt. */
export const addedPromptResult = (
  def: AddedPrompt,
  args: Record<string, string>,
): HostedPromptResult => {
  const declared = new Set((def.arguments ?? []).map((a) => a.name));
  return {
    ...(def.description === undefined ? {} : { description: def.description }),
    messages: def.messages.map((m) => ({
      role: m.role,
      content: { type: 'text', text: fill(m.text, declared, args) },
    })),
  };
};

/** The names of a prompt's required arguments that the client did not pass. */
export const missingPromptArguments = (def: AddedPrompt, args: Record<string, string>): string[] =>
  (def.arguments ?? []).filter((a) => a.required === true && !args[a.name]).map((a) => a.name);

export type HostedContents = {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} & JsonObject;

/** `resources/read` for an added resource. */
export const addedResourceContents = (uri: string, def: AddedResource): HostedContents => ({
  contents: [{ uri, mimeType: def.mimeType ?? 'text/plain', text: def.text }],
});

/** `resources/read` for a URI that matches an added template; `null` when it does not match. */
export const addedTemplateContents = (
  uriTemplate: string,
  def: AddedResourceTemplate,
  uri: string,
): HostedContents | null => {
  const variables = matchUriTemplate(uriTemplate, uri);
  if (variables === null) return null;
  const declared = new Set(templateVariables(uriTemplate));
  return {
    contents: [
      {
        uri,
        mimeType: def.mimeType ?? 'text/plain',
        text: fill(def.text, declared, variables),
      },
    ],
  };
};
