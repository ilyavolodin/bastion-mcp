/**
 * Effective endpoint compilation (7.2). `compileEndpoint` loads items through providers (async) and hands
 * everything to `assembleEndpoint`, which is pure and synchronous over the loaded data.
 */
import {
  canonicalJson,
  MAX_INSTRUCTIONS_CHARS,
  type NameCandidate,
  resolveNames,
  sanitizeNamePart,
  sha256Hex,
} from '@bastion-mcp/core';
import {
  applyInstructions,
  applyToPrompt,
  applyToResource,
  applyToResourceTemplate,
  applyToTool,
  type FinalPrompt,
  type FinalResource,
  type FinalResourceTemplate,
  type FinalTool,
  type MergedAdded,
  mergedAdded,
  type OverrideIssue,
  type OverrideLayers,
  type OverridesDocument,
  type PromptPlan,
  type ResourceRoute,
  resolvePromptOverride,
  resolveToolOverride,
  type ToolPlan,
  type UpstreamPrompt,
  type UpstreamResource,
  type UpstreamResourceTemplate,
  type UpstreamTool,
  withAdded,
} from '@bastion-mcp/overrides';
import type {
  AuthorizeRequest,
  Decision,
  InstallationData,
  McpRequestContext,
  PrincipalData,
  VisibilityResource,
} from '@bastion-mcp/policy';
import { effectiveSlug } from './endpoint-path';
import { capList, mergedTtlMs } from './listing';
import {
  type EndpointProvider,
  loadProvider,
  type ProviderContext,
  type ProviderListing,
  type UpstreamItemSource,
  UpstreamProvider,
} from './provider';
import type {
  Collision,
  DegradedEntry,
  EffectiveEndpoint,
  EndpointCapabilities,
  EndpointDefinition,
  EndpointWarning,
  InstallationInfo,
  InstallationSummary,
  ItemKind,
  ItemMeta,
  NeedsAuthEntry,
  PromptRoute,
  ToolRoute,
  UpstreamItems,
} from './types';
import { buildUriIndex, type UriIndexInput } from './uri-index';

/** The slice of `PolicyEngine` the compiler uses (a port, so tests can stub it). */
export interface EndpointPolicy {
  authorize(request: AuthorizeRequest): Decision;
  filterVisible<T extends VisibilityResource>(
    request: {
      principal: PrincipalData;
      action: 'seeTool' | 'seePrompt' | 'seeResource';
      context: McpRequestContext;
    },
    items: readonly T[],
  ): { visible: T[]; hidden: Array<{ item: T; reasons: string[] }> };
}

export type CompileInput = {
  principal: PrincipalData;
  endpoint: EndpointDefinition;
  /** Every installation the principal could use: their own and their teams' (11.4). */
  installations: readonly InstallationInfo[];
  /** `installation_prefs.hidden` for this principal (11.4). */
  hiddenInstallationIds?: readonly string[];
  source: UpstreamItemSource;
  /** Extra providers (for example native ones, 26) appended after the upstream ones. */
  extraProviders?: readonly EndpointProvider[];
  policy: EndpointPolicy;
  requestContext: McpRequestContext;
  org: { displayName: string };
  serverVersion: string;
  configVersion: string;
  signal?: AbortSignal | undefined;
};

export const SERVER_NAME = 'bastion';
const BAD_STATUSES: ReadonlySet<string> = new Set(['disabled', 'needs_setup']);
const SINGLE_KINDS: ReadonlySet<string> = new Set(['installation', 'catalog']);
/** `installations.origin` of the hidden installation a catalog TEST runs against (11.3). */
const TEST_ORIGIN = 'test';

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const principalTeamIds = (principal: PrincipalData): string[] =>
  principal.kind === 'user' ? principal.teams.map((t) => t.id) : [principal.team.id];

const belongsTo = (i: InstallationInfo, principal: PrincipalData, teamIds: readonly string[]) => {
  switch (i.owner.kind) {
    case 'user':
      return principal.kind === 'user' && i.owner.id === principal.id;
    case 'team':
      return teamIds.includes(i.owner.id);
    case 'service':
      return (
        (principal.kind === 'service' && i.owner.id === principal.id) ||
        (i.owner.teamId !== undefined && teamIds.includes(i.owner.teamId))
      );
  }
};

/** Step 1 of 7.2: the endpoint's installations in priority order, before Cedar. */
export const selectInstallations = (
  input: Pick<CompileInput, 'principal' | 'endpoint' | 'installations' | 'hiddenInstallationIds'>,
): InstallationInfo[] => {
  const { principal, endpoint } = input;
  const teamIds = principalTeamIds(principal);
  const hidden = new Set(input.hiddenInstallationIds ?? []);
  const single = SINGLE_KINDS.has(endpoint.kind);
  const usable = input.installations.filter(
    (i) =>
      i.enabled &&
      !BAD_STATUSES.has(i.status) &&
      belongsTo(i, principal, teamIds) &&
      (endpoint.kind === 'installation' || i.origin !== TEST_ORIGIN) &&
      (single || i.owner.kind !== 'team' || !hidden.has(i.id)),
  );
  if (endpoint.kind === 'default') {
    return [...usable].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        compareStrings(a.displayName.toLowerCase(), b.displayName.toLowerCase()) ||
        compareStrings(a.id, b.id),
    );
  }
  const byId = new Map(usable.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const ordered: InstallationInfo[] = [];
  for (const id of endpoint.installationIds ?? []) {
    const inst = byId.get(id);
    if (inst && !seen.has(id)) {
      seen.add(id);
      ordered.push(inst);
    }
  }
  return ordered;
};

const installationData = (i: InstallationInfo): InstallationData => {
  const data: InstallationData = i.policy ?? { id: i.id, catalogEntryId: i.catalogEntryId };
  if (i.policy) return data;
  if (i.owner.kind === 'user') data.ownerUserId = i.owner.id;
  else if (i.owner.kind === 'team') data.ownerTeamId = i.owner.id;
  else {
    data.ownerServiceId = i.owner.id;
    if (i.owner.teamId !== undefined) data.ownerServiceTeamId = i.owner.teamId;
  }
  return data;
};

/** Step 2 of 7.2: drops installations Cedar does not allow (`useInstallation`). */
export const filterUsableInstallations = (
  installations: readonly InstallationInfo[],
  input: Pick<CompileInput, 'principal' | 'policy' | 'requestContext'>,
): InstallationInfo[] =>
  installations.filter(
    (i) =>
      input.policy.authorize({
        principal: input.principal,
        action: 'useInstallation',
        resource: { type: 'Installation', ...installationData(i) },
        context: input.requestContext,
      }).decision === 'allow',
  );

export type LoadedInstallation = { installation: InstallationInfo; listing: ProviderListing };

/** Selects, authorizes and loads the installations of an endpoint, then assembles it. */
export const compileEndpoint = async (input: CompileInput): Promise<EffectiveEndpoint> => {
  const selected = filterUsableInstallations(selectInstallations(input), input);
  const ctx: ProviderContext = {
    principalId: input.principal.id,
    endpointId: input.endpoint.id,
    signal: input.signal,
  };
  const providers: EndpointProvider[] = [
    ...selected.map((i) => new UpstreamProvider(i, input.source)),
    ...(input.extraProviders ?? []),
  ];
  const loaded = await Promise.all(
    providers.map(
      async (p): Promise<LoadedInstallation> => ({
        installation: p.installation,
        listing: await loadProvider(p, ctx),
      }),
    ),
  );
  return assembleEndpoint(loaded, input);
};

// --- assembly -------------------------------------------------------------------------------------

type Entry<F> = {
  installation: InstallationInfo;
  priority: number;
  upstreamKey: string;
  final: F | null;
  issues: OverrideIssue[];
  overridden: boolean;
};

type ToolEntry = Entry<FinalTool> & { tool: UpstreamTool; exactName?: string };
type PromptEntry = Entry<FinalPrompt> & { prompt: UpstreamPrompt; exactName?: string };

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const hasEntries = (doc: OverridesDocument | undefined, key: keyof OverridesDocument): boolean => {
  const v = doc?.[key];
  return typeof v === 'object' && v !== null && Object.keys(v).length > 0;
};
const hasOverrides = (layers: OverrideLayers, key: keyof OverridesDocument): boolean =>
  hasEntries(layers.catalog, key) || hasEntries(layers.installation, key);
const wantsUriPrefix = (layers: OverrideLayers): boolean =>
  (layers.installation?.uriPrefix ?? layers.catalog?.uriPrefix) === true;

/**
 * A catalog-layer pin cannot be changed by the user layer, even at `full` level (12.1): the catalog value
 * is re-applied last.
 */
const enforceCatalogToolPins = (
  final: FinalTool,
  layers: OverrideLayers,
  upstreamName: string,
): void => {
  if (!layers.catalog || !layers.installation) return;
  const pins = resolveToolOverride({ catalog: layers.catalog }, upstreamName).pinnedArguments;
  for (const [key, value] of Object.entries(pins ?? {})) {
    if (!sameJson(final.plan.pinned[key], value)) {
      final.plan.pinned[key] = value;
      final.plan.validate = true;
      final.issues.push({
        code: 'catalog_pin_enforced',
        message: `pinned argument "${key}" is set by the catalog and cannot be changed`,
        path: `/pinnedArguments/${key}`,
      });
    }
  }
};

const enforceCatalogPromptPins = (
  final: FinalPrompt,
  layers: OverrideLayers,
  upstreamName: string,
): void => {
  if (!layers.catalog || !layers.installation) return;
  const args = resolvePromptOverride({ catalog: layers.catalog }, upstreamName).arguments ?? {};
  for (const [name, arg] of Object.entries(args)) {
    if (arg.pinned === undefined || final.plan.pinned[name] === arg.pinned) continue;
    final.plan.pinned[name] = arg.pinned;
    final.issues.push({
      code: 'catalog_pin_enforced',
      message: `pinned prompt argument "${name}" is set by the catalog and cannot be changed`,
      path: `/arguments/${name}/pinned`,
    });
  }
};

const policyAnnotations = (tool: UpstreamTool) => {
  const a = tool.annotations ?? {};
  const out: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } = {};
  if (typeof a.readOnlyHint === 'boolean') out.readOnlyHint = a.readOnlyHint;
  if (typeof a.destructiveHint === 'boolean') out.destructiveHint = a.destructiveHint;
  if (typeof a.openWorldHint === 'boolean') out.openWorldHint = a.openWorldHint;
  return out;
};

const toolCountsFor = <T extends { installation: InstallationInfo }>(list: readonly T[]) => {
  const counts = new Map<string, number>();
  for (const e of list) counts.set(e.installation.id, (counts.get(e.installation.id) ?? 0) + 1);
  return counts;
};

const detectCollisions = <T extends { installation: InstallationInfo }>(
  kind: 'tool' | 'prompt',
  entries: readonly T[],
  names: readonly string[],
  bare: (e: T) => string,
  mode: 'always' | 'onCollision',
): Collision[] => {
  const found = new Map<string, Set<string>>();
  const add = (name: string, ...ids: string[]) => {
    const set = found.get(name) ?? new Set<string>();
    for (const id of ids) set.add(id);
    found.set(name, set);
  };
  const byName = new Map<string, number>();
  names.forEach((n, i) => {
    byName.set(n, i);
  });
  entries.forEach((e, i) => {
    const name = names[i] as string;
    const base = name.replace(/_\d+$/, '');
    const winner = base === name ? undefined : byName.get(base);
    if (winner !== undefined) {
      const w = entries[winner] as T;
      if (w.installation.id !== e.installation.id) add(base, w.installation.id, e.installation.id);
    }
  });
  if (mode === 'onCollision') {
    const groups = new Map<string, string[]>();
    for (const e of entries) {
      const key = bare(e);
      groups.set(key, [...(groups.get(key) ?? []), e.installation.id]);
    }
    for (const [name, ids] of groups) if (new Set(ids).size > 1) add(name, ...ids);
  }
  return [...found]
    .map(([name, ids]) => ({ kind, name, installationIds: [...ids].sort() }))
    .sort((a, b) => compareStrings(a.name, b.name));
};

const buildInstructions = (
  endpoint: EndpointDefinition,
  parts: ReadonlyArray<{ installation: InstallationInfo; upstream: string | undefined }>,
): string | undefined => {
  const sections: string[] = [];
  if (endpoint.instructions && endpoint.instructions.trim() !== '') {
    sections.push(endpoint.instructions.trim());
  }
  for (const { installation, upstream } of parts) {
    const text = applyInstructions(upstream, installation.layers);
    if (text !== undefined && text.trim() !== '') {
      sections.push(`## ${installation.displayName}\n${text.trim()}`);
    }
  }
  if (sections.length === 0) return undefined;
  const joined = sections.join('\n\n');
  if (joined.length <= MAX_INSTRUCTIONS_CHARS) return joined;
  let cut = joined.slice(0, MAX_INSTRUCTIONS_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
};

/** Steps 3 to 8 of 7.2 over already-loaded data. Deterministic: same input, same output. */
export const assembleEndpoint = (
  loaded: readonly LoadedInstallation[],
  input: CompileInput,
): EffectiveEndpoint => {
  const { principal, endpoint, policy, requestContext } = input;
  const single = SINGLE_KINDS.has(endpoint.kind);
  const mode = single ? 'onCollision' : endpoint.prefixMode;
  const degraded: DegradedEntry[] = [];
  const needsAuth: NeedsAuthEntry[] = [];
  const warnings: EndpointWarning[] = [];
  const instData = new Map<string, InstallationData>();
  /** What Bastion itself serves for each installation (12.2 `added`). */
  const addedOf = new Map<string, MergedAdded>();

  const toolEntries: ToolEntry[] = [];
  const promptEntries: PromptEntry[] = [];
  const resourceEntries: Array<Entry<FinalResource> & { resource: UpstreamResource }> = [];
  const templateEntries: Array<
    Entry<FinalResourceTemplate> & { template: UpstreamResourceTemplate }
  > = [];
  const instructionParts: Array<{ installation: InstallationInfo; upstream: string | undefined }> =
    [];
  const loadedItems: UpstreamItems[] = [];

  loaded.forEach(({ installation, listing }, priority) => {
    const slug = effectiveSlug(installation);
    instData.set(installation.id, installationData(installation));
    if (installation.needsAuth) needsAuth.push({ installation: slug });
    if (listing.status === 'degraded') {
      if (!installation.needsAuth) degraded.push({ installation: slug, code: listing.code });
      instructionParts.push({ installation, upstream: undefined });
      return;
    }
    addedOf.set(installation.id, mergedAdded(installation.layers));
    const src = withAdded(listing.items, installation.layers);
    loadedItems.push(src);
    instructionParts.push({ installation, upstream: src.instructions });
    const layers = installation.layers;
    const base = { installation, priority };
    const trunc = (kind: ItemKind, truncated: boolean) => {
      if (truncated) warnings.push({ code: 'list_truncated', installation: slug, kind });
    };
    const invalid = (kind: ItemKind, key: string, error: string) =>
      warnings.push({ code: 'invalid_override', installation: slug, kind, key, error });

    const tools = capList(src.tools);
    trunc('tool', tools.truncated);
    const toolOverrides = hasOverrides(layers, 'tools');
    for (const upstream of tools.items) {
      if (!toolOverrides) {
        toolEntries.push({
          ...base,
          upstreamKey: upstream.name,
          final: null,
          issues: [],
          overridden: false,
          tool: upstream,
        });
        continue;
      }
      const r = applyToTool(upstream, layers);
      if (r.kind === 'hidden') continue;
      if (r.kind === 'invalid') {
        invalid('tool', upstream.name, r.error);
        continue;
      }
      enforceCatalogToolPins(r, layers, upstream.name);
      const entry: ToolEntry = {
        ...base,
        upstreamKey: upstream.name,
        final: r,
        issues: r.issues,
        overridden: Object.keys(resolveToolOverride(layers, upstream.name)).length > 0,
        tool: r.tool,
      };
      if (r.exactName !== undefined) entry.exactName = r.exactName;
      toolEntries.push(entry);
    }

    const prompts = capList(src.prompts);
    trunc('prompt', prompts.truncated);
    const promptOverrides = hasOverrides(layers, 'prompts');
    for (const upstream of prompts.items) {
      if (!promptOverrides) {
        promptEntries.push({
          ...base,
          upstreamKey: upstream.name,
          final: null,
          issues: [],
          overridden: false,
          prompt: upstream,
        });
        continue;
      }
      const r = applyToPrompt(upstream, layers);
      if (r.kind === 'hidden') continue;
      if (r.kind === 'invalid') {
        invalid('prompt', upstream.name, r.error);
        continue;
      }
      enforceCatalogPromptPins(r, layers, upstream.name);
      const entry: PromptEntry = {
        ...base,
        upstreamKey: upstream.name,
        final: r,
        issues: r.issues,
        overridden: Object.keys(resolvePromptOverride(layers, upstream.name)).length > 0,
        prompt: r.prompt,
      };
      if (r.exactName !== undefined) entry.exactName = r.exactName;
      promptEntries.push(entry);
    }

    const prefixed = wantsUriPrefix(layers);
    const resources = capList(src.resources);
    trunc('resource', resources.truncated);
    for (const upstream of resources.items) {
      if (!prefixed && !hasOverrides(layers, 'resources')) {
        resourceEntries.push({
          ...base,
          upstreamKey: upstream.uri,
          final: null,
          issues: [],
          overridden: false,
          resource: upstream,
        });
        continue;
      }
      const r = applyToResource(upstream, layers, { installationSlug: slug });
      if (r.kind === 'hidden') continue;
      if (r.kind === 'invalid') {
        invalid('resource', upstream.uri, r.error);
        continue;
      }
      resourceEntries.push({
        ...base,
        upstreamKey: upstream.uri,
        final: r,
        issues: r.issues,
        overridden:
          r.resource.uri !== upstream.uri ||
          r.resource.title !== upstream.title ||
          r.resource.description !== upstream.description,
        resource: r.resource,
      });
    }
    const templates = capList(src.resourceTemplates);
    trunc('resourceTemplate', templates.truncated);
    for (const upstream of templates.items) {
      if (!prefixed && !hasOverrides(layers, 'resourceTemplates')) {
        templateEntries.push({
          ...base,
          upstreamKey: upstream.uriTemplate,
          final: null,
          issues: [],
          overridden: false,
          template: upstream,
        });
        continue;
      }
      const r = applyToResourceTemplate(upstream, layers, { installationSlug: slug });
      if (r.kind === 'hidden') continue;
      if (r.kind === 'invalid') {
        invalid('resourceTemplate', upstream.uriTemplate, r.error);
        continue;
      }
      templateEntries.push({
        ...base,
        upstreamKey: upstream.uriTemplate,
        final: r,
        issues: r.issues,
        overridden: true,
        template: r.template,
      });
    }
  });

  // Namespacing (7.3): tools and prompts resolve in separate namespaces.
  const candidates = <E extends Entry<unknown> & { exactName?: string }>(list: readonly E[]) =>
    list.map((e, i): NameCandidate => {
      const c: NameCandidate = {
        key: String(i),
        installationId: e.installation.id,
        priority: e.priority,
        prefix: e.installation.toolPrefix,
        upstreamName: e.upstreamKey,
      };
      if (e.exactName !== undefined) c.exactName = e.exactName;
      return c;
    });
  const toolNames = resolveNames(candidates(toolEntries), mode).map((r) => r.name);
  const promptNames = resolveNames(candidates(promptEntries), mode).map((r) => r.name);

  // Cedar visibility (7.2) with FINAL annotations; the policy sees upstream names and URIs.
  const instOf = (e: { installation: InstallationInfo }): InstallationData =>
    instData.get(e.installation.id) as InstallationData;
  const toolRes = toolEntries.map(
    (e): VisibilityResource => ({
      type: 'Tool',
      installation: instOf(e),
      name: e.upstreamKey,
      annotations: policyAnnotations(e.tool),
    }),
  );
  const seeRequest = (action: 'seeTool' | 'seePrompt' | 'seeResource') => ({
    principal,
    action,
    context: requestContext,
  });
  const visibleTools = new Set<VisibilityResource>(
    policy.filterVisible(seeRequest('seeTool'), toolRes).visible,
  );
  const promptRes = promptEntries.map(
    (e): VisibilityResource => ({ type: 'Prompt', installation: instOf(e), name: e.upstreamKey }),
  );
  const visiblePrompts = new Set<VisibilityResource>(
    policy.filterVisible(seeRequest('seePrompt'), promptRes).visible,
  );
  const resRes = [...resourceEntries, ...templateEntries].map(
    (e): VisibilityResource => ({ type: 'Resource', installation: instOf(e), uri: e.upstreamKey }),
  );
  const visibleRes = new Set<VisibilityResource>(
    policy.filterVisible(seeRequest('seeResource'), resRes).visible,
  );

  const items: ItemMeta[] = [];
  const toolRoutes = new Map<string, ToolRoute>();
  const finalTools: UpstreamTool[] = [];
  const keptTools: ToolEntry[] = [];
  const keptToolNames: string[] = [];
  toolEntries.forEach((e, i) => {
    if (!visibleTools.has(toolRes[i] as VisibilityResource)) return;
    const name = toolNames[i] as string;
    keptTools.push(e);
    keptToolNames.push(name);
    finalTools.push({ ...e.tool, name });
    const plan: ToolPlan | undefined = e.final?.plan;
    toolRoutes.set(name, {
      installationId: e.installation.id,
      upstreamName: e.upstreamKey,
      finalName: name,
      plan,
    });
  });
  const promptRoutes = new Map<string, PromptRoute>();
  const finalPrompts: UpstreamPrompt[] = [];
  const keptPrompts: PromptEntry[] = [];
  const keptPromptNames: string[] = [];
  promptEntries.forEach((e, i) => {
    if (!visiblePrompts.has(promptRes[i] as VisibilityResource)) return;
    const name = promptNames[i] as string;
    keptPrompts.push(e);
    keptPromptNames.push(name);
    finalPrompts.push({ ...e.prompt, name });
    const plan: PromptPlan | undefined = e.final?.plan;
    const hosted = addedOf.get(e.installation.id)?.prompts[e.upstreamKey];
    promptRoutes.set(name, {
      installationId: e.installation.id,
      upstreamName: e.upstreamKey,
      finalName: name,
      plan,
      ...(hosted ? { hosted } : {}),
    });
  });

  const bareName = (e: { exactName?: string; upstreamKey: string }): string =>
    sanitizeNamePart(e.exactName ?? e.upstreamKey);
  const collisions = [
    ...detectCollisions('tool', keptTools, keptToolNames, bareName, mode),
    ...detectCollisions('prompt', keptPrompts, keptPromptNames, bareName, mode),
  ];
  const collided = new Set(collisions.map((c) => `${c.kind}\0${c.name}`));
  const isCollided = (
    kind: 'tool' | 'prompt',
    name: string,
    e: { exactName?: string; upstreamKey: string },
  ) =>
    collided.has(`${kind}\0${name}`) ||
    collided.has(`${kind}\0${name.replace(/_\d+$/, '')}`) ||
    collided.has(`${kind}\0${bareName(e)}`);

  keptTools.forEach((e, i) => {
    const name = keptToolNames[i] as string;
    const meta: ItemMeta = {
      kind: 'tool',
      installationId: e.installation.id,
      upstreamKey: e.upstreamKey,
      finalKey: name,
      overridden: e.overridden,
      renamed: name !== e.upstreamKey,
      collided: isCollided('tool', name, e),
      issues: e.issues,
    };
    if (e.final?.invalid) meta.invalidPatch = e.final.invalid.error;
    items.push(meta);
  });
  keptPrompts.forEach((e, i) => {
    const name = keptPromptNames[i] as string;
    items.push({
      kind: 'prompt',
      installationId: e.installation.id,
      upstreamKey: e.upstreamKey,
      finalKey: name,
      overridden: e.overridden,
      ...(addedOf.get(e.installation.id)?.prompts[e.upstreamKey] ? { added: true as const } : {}),
      renamed: name !== e.upstreamKey,
      collided: isCollided('prompt', name, e),
      issues: e.issues,
    });
  });

  // URI index (7.4).
  const uriInput: UriIndexInput = { resources: [], templates: [], seen: [], rewritten: [] };
  const keptResources: typeof resourceEntries = [];
  resourceEntries.forEach((e, i) => {
    if (!visibleRes.has(resRes[i] as VisibilityResource)) return;
    keptResources.push(e);
    const hostedDef = addedOf.get(e.installation.id)?.resources[e.upstreamKey];
    const base: ResourceRoute = e.final?.route ?? { kind: 'resource' };
    const route: ResourceRoute = hostedDef
      ? { ...base, hosted: { kind: 'resource', def: hostedDef } }
      : base;
    uriInput.resources.push({
      installationId: e.installation.id,
      advertisedUri: e.resource.uri,
      upstreamUri: e.upstreamKey,
      route,
    });
  });
  const keptTemplates: typeof templateEntries = [];
  templateEntries.forEach((e, i) => {
    if (!visibleRes.has(resRes[resourceEntries.length + i] as VisibilityResource)) return;
    keptTemplates.push(e);
    const hostedDef = addedOf.get(e.installation.id)?.resourceTemplates[e.upstreamKey];
    const base: ResourceRoute = e.final?.route ?? {
      kind: 'template',
      upstreamTemplate: e.upstreamKey,
      pinnedVariables: {},
    };
    uriInput.templates.push({
      installationId: e.installation.id,
      advertised: e.template.uriTemplate,
      route: hostedDef
        ? { ...base, hosted: { kind: 'template', uriTemplate: e.upstreamKey, def: hostedDef } }
        : base,
    });
  });
  for (const e of keptTools) {
    const ui = (e.tool._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui;
    if (typeof ui?.resourceUri === 'string') {
      uriInput.seen.push({ installationId: e.installation.id, uri: ui.resourceUri });
    }
  }
  for (const { installation } of loaded) {
    if (wantsUriPrefix(installation.layers)) {
      uriInput.rewritten.push({
        slug: effectiveSlug(installation),
        installationId: installation.id,
      });
    }
  }
  const { index, conflicts, hiddenKeys } = buildUriIndex(uriInput);
  for (const c of conflicts) warnings.push({ code: 'uri_conflict', ...c });
  const finalResources: UpstreamResource[] = [];
  for (const e of keptResources) {
    if (hiddenKeys.has(`${e.installation.id}\0${e.resource.uri}`)) continue;
    finalResources.push(e.resource);
    items.push({
      kind: 'resource',
      installationId: e.installation.id,
      upstreamKey: e.upstreamKey,
      finalKey: e.resource.uri,
      overridden: e.overridden,
      ...(addedOf.get(e.installation.id)?.resources[e.upstreamKey] ? { added: true as const } : {}),
      renamed: e.resource.uri !== e.upstreamKey,
      collided: false,
      issues: e.issues,
    });
  }
  const finalTemplates: UpstreamResourceTemplate[] = [];
  for (const e of keptTemplates) {
    finalTemplates.push(e.template);
    items.push({
      kind: 'resourceTemplate',
      installationId: e.installation.id,
      upstreamKey: e.upstreamKey,
      finalKey: e.template.uriTemplate,
      overridden: e.overridden,
      ...(addedOf.get(e.installation.id)?.resourceTemplates[e.upstreamKey]
        ? { added: true as const }
        : {}),
      renamed: e.template.uriTemplate !== e.upstreamKey,
      collided: false,
      issues: e.issues,
    });
  }

  // Deterministic order (6.7).
  finalTools.sort((a, b) => compareStrings(a.name, b.name));
  finalPrompts.sort((a, b) => compareStrings(a.name, b.name));
  finalResources.sort((a, b) => compareStrings(a.uri, b.uri));
  finalTemplates.sort((a, b) => compareStrings(a.uriTemplate, b.uriTemplate));
  items.sort(
    (a, b) =>
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.finalKey, b.finalKey) ||
      compareStrings(a.installationId, b.installationId),
  );

  // Capabilities and instructions (7.6).
  const capabilities: EndpointCapabilities = {};
  const anyCap = (key: 'tools' | 'prompts' | 'resources' | 'completions' | 'subscribe') =>
    loaded.some((l) => l.installation.capabilities[key] === true);
  if (anyCap('tools') || finalTools.length > 0) capabilities.tools = { listChanged: true };
  if (anyCap('prompts') || finalPrompts.length > 0) capabilities.prompts = { listChanged: true };
  if (anyCap('resources') || finalResources.length > 0 || finalTemplates.length > 0) {
    capabilities.resources = anyCap('subscribe')
      ? { listChanged: true, subscribe: true }
      : { listChanged: true };
  }
  if (anyCap('completions')) capabilities.completions = {};

  const counts = {
    tool: toolCountsFor(keptTools),
    prompt: toolCountsFor(keptPrompts),
    resource: toolCountsFor(keptResources),
  };
  const degradedSlugs = new Set(degraded.map((d) => d.installation));
  const installations: InstallationSummary[] = loaded.map(({ installation }) => ({
    id: installation.id,
    slug: effectiveSlug(installation),
    displayName: installation.displayName,
    toolCount: counts.tool.get(installation.id) ?? 0,
    promptCount: counts.prompt.get(installation.id) ?? 0,
    resourceCount: counts.resource.get(installation.id) ?? 0,
    collisionCount: collisions.filter((c) => c.installationIds.includes(installation.id)).length,
    degraded: degradedSlugs.has(effectiveSlug(installation)),
  }));

  const instructions = buildInstructions(endpoint, instructionParts);
  const teamIds = new Set(principalTeamIds(principal));
  for (const { installation } of loaded) {
    if (installation.owner.kind === 'team') teamIds.add(installation.owner.id);
  }
  const endpointOut: EffectiveEndpoint = {
    endpointId: endpoint.id,
    principalId: principal.id,
    configVersion: input.configVersion,
    hash: sha256Hex(
      canonicalJson([
        finalTools.map((t) => t.name),
        finalPrompts.map((p) => p.name),
        finalResources.map((r) => r.uri),
        finalTemplates.map((t) => t.uriTemplate),
      ]),
    ).slice(0, 16),
    kind: endpoint.kind,
    prefixing: mode === 'always',
    tools: finalTools,
    prompts: finalPrompts,
    resources: finalResources,
    resourceTemplates: finalTemplates,
    toolRoutes,
    promptRoutes,
    uriIndex: index,
    capabilities,
    serverInfo: {
      name: SERVER_NAME,
      title: `${input.org.displayName} MCP`,
      version: input.serverVersion,
    },
    degraded,
    needsAuth,
    items,
    collisions,
    warnings,
    installations,
    ttlMs: mergedTtlMs(loadedItems.map((i) => i.ttlMs)),
    cacheScope: 'private',
    dependencies: {
      installationIds: loaded.map((l) => l.installation.id),
      catalogEntryIds: [...new Set(loaded.map((l) => l.installation.catalogEntryId))],
      teamIds: [...teamIds],
    },
  };
  if (instructions !== undefined) endpointOut.instructions = instructions;
  return endpointOut;
};

/** A stable string form of an endpoint (Maps become sorted entry lists), for hashing and golden tests. */
export const serializeEndpoint = (endpoint: EffectiveEndpoint): string => {
  const { toolRoutes, promptRoutes, uriIndex, ...rest } = endpoint;
  const sortedEntries = <V>(m: Map<string, V>) => [...m].sort(([a], [b]) => compareStrings(a, b));
  return canonicalJson({
    ...rest,
    toolRoutes: sortedEntries(toolRoutes),
    promptRoutes: sortedEntries(promptRoutes),
    uriIndex: {
      exact: sortedEntries(uriIndex.exact),
      seen: sortedEntries(uriIndex.seen),
      templates: uriIndex.templates,
      rewritten: sortedEntries(uriIndex.rewritten),
    },
  });
};
