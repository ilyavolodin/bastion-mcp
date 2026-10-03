/**
 * Shapes shared by the router modules (7.2): inputs are plain data loaded by the caller, the output is
 * an `EffectiveEndpoint` that workers cache per (principal, endpoint, configVersion) (4.3).
 */
import type { PrefixMode } from '@bastion-mcp/core';
import type {
  AddedPrompt,
  FinalPrompt,
  FinalTool,
  OverrideIssue,
  OverrideLayers,
  PromptPlan,
  ResourceRoute,
  ToolPlan,
  UpstreamPrompt,
  UpstreamResource,
  UpstreamResourceTemplate,
  UpstreamTool,
} from '@bastion-mcp/overrides';
import type { InstallationData } from '@bastion-mcp/policy';
import type { UriIndex } from './uri-index';

export type { PrefixMode };

export type InstallationStatus =
  | 'ready'
  | 'needs_setup'
  | 'reconnect_required'
  | 'error'
  | 'disabled';

/** Who owns an installation (11.4). A team installation's effective slug is `{teamSlug}-{slug}` (7.1). */
export type InstallationOwner =
  | { kind: 'user'; id: string }
  | { kind: 'team'; id: string; slug: string }
  | { kind: 'service'; id: string; teamId?: string };

/** What the upstream declared at `initialize` (7.6). */
export type UpstreamCapabilities = {
  tools?: boolean;
  prompts?: boolean;
  resources?: boolean;
  completions?: boolean;
  /** `resources.subscribe` */
  subscribe?: boolean;
};

/** An installation as the router needs it (11.4); `packages/db` maps its rows to this. */
export type InstallationInfo = {
  id: string;
  slug: string;
  /** Prefix for final names; defaults to the slug with `-` replaced by `_` (7.3). */
  toolPrefix: string;
  displayName: string;
  owner: InstallationOwner;
  enabled: boolean;
  status: InstallationStatus;
  catalogEntryId: string;
  catalogVersionId?: string;
  /** Slug of the catalog entry, used by `/mcp/c/{catalogSlug}` (7.1). */
  catalogSlug?: string;
  /** Catalog layer then installation layer (12.1). */
  layers: OverrideLayers;
  /** The installation stays on its catalog version (11.4); the default endpoint lists these first. */
  pinned: boolean;
  capabilities: UpstreamCapabilities;
  /** Only OAuth is missing: still served, the first call elicits (11.4). */
  needsAuth: boolean;
  /** Catalog layer rule (12.1): the user layer may not change catalog pins. Informational. */
  policy?: InstallationData;
  /**
   * How the installation came to be (`catalog`, `manual`, `test`...). The hidden installation a catalog TEST runs
   * against (`test`) is only reachable on its own endpoint, never in a default, named or catalog endpoint.
   */
  origin?: string;
};

export type EndpointKind = 'default' | 'named' | 'installation' | 'catalog';

/** The endpoint the request addressed (7.1). Single-installation and catalog endpoints never prefix (7.3). */
export type EndpointDefinition = {
  id: string;
  kind: EndpointKind;
  slug?: string;
  /** Ordered; the order sets priority (7.1). For `installation` endpoints, exactly one id. */
  installationIds?: string[];
  prefixMode: PrefixMode;
  /** Extra instructions that come first (7.6). */
  instructions?: string;
};

export type UpstreamServerInfo = { name: string; version: string; title?: string };

/** Plain MCP definitions; the SDK's `Tool`, `Prompt`, `Resource` and `ResourceTemplate` are assignable. */
export type UpstreamItems = {
  tools: UpstreamTool[];
  prompts: UpstreamPrompt[];
  resources: UpstreamResource[];
  resourceTemplates: UpstreamResourceTemplate[];
  instructions?: string | undefined;
  serverInfo?: UpstreamServerInfo | undefined;
  /** The upstream's `ttlMs` for these lists, when it sent one (6.7). */
  ttlMs?: number | undefined;
};

export type DegradedEntry = { installation: string; code: string };
export type NeedsAuthEntry = { installation: string };

export type ToolRoute = {
  installationId: string;
  upstreamName: string;
  finalName: string;
  /** Absent for tools without overrides (arguments pass through, 12.4). */
  plan?: ToolPlan | undefined;
};

export type PromptRoute = {
  installationId: string;
  upstreamName: string;
  finalName: string;
  plan?: PromptPlan | undefined;
  /** Bastion answers this prompt itself (12.2 `added`). */
  hosted?: AddedPrompt | undefined;
};

export type EndpointCapabilities = {
  tools?: { listChanged: true };
  prompts?: { listChanged: true };
  resources?: { listChanged: true; subscribe?: true };
  completions?: Record<string, never>;
};

export type ItemKind = 'tool' | 'prompt' | 'resource' | 'resourceTemplate';

/** Per-item metadata for the UI (12.5): override markers, renames, collisions. */
export type ItemMeta = {
  kind: ItemKind;
  installationId: string;
  /** Upstream name, URI or URI template. */
  upstreamKey: string;
  /** Final name, URI or URI template as the client sees it. */
  finalKey: string;
  overridden: boolean;
  /** Written in the override document and served by Bastion (12.2 `added`). */
  added?: true;
  renamed: boolean;
  collided: boolean;
  issues: OverrideIssue[];
  /** The schema patch was invalid and not applied (12.3). */
  invalidPatch?: string;
};

/** Two or more items that wanted the same name (7.3); flagged on every installation involved. */
export type Collision = {
  kind: 'tool' | 'prompt';
  name: string;
  installationIds: string[];
};

export type EndpointWarning =
  | { code: 'list_truncated'; installation: string; kind: ItemKind }
  | { code: 'invalid_override'; installation: string; kind: ItemKind; key: string; error: string }
  | { code: 'uri_conflict'; uri: string; owner: string; hidden: string };

export type InstallationSummary = {
  id: string;
  slug: string;
  displayName: string;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  collisionCount: number;
  degraded: boolean;
};

export type EffectiveEndpoint = {
  endpointId: string;
  principalId: string;
  configVersion: string;
  /** Changes whenever the served lists change; embedded in list cursors (7.5). */
  hash: string;
  kind: EndpointKind;
  prefixing: boolean;
  /** Merged and sorted by final name (6.7). */
  tools: UpstreamTool[];
  prompts: UpstreamPrompt[];
  resources: UpstreamResource[];
  resourceTemplates: UpstreamResourceTemplate[];
  toolRoutes: Map<string, ToolRoute>;
  promptRoutes: Map<string, PromptRoute>;
  uriIndex: UriIndex;
  capabilities: EndpointCapabilities;
  instructions?: string;
  serverInfo: { name: 'bastion'; title: string; version: string };
  degraded: DegradedEntry[];
  needsAuth: NeedsAuthEntry[];
  items: ItemMeta[];
  collisions: Collision[];
  warnings: EndpointWarning[];
  installations: InstallationSummary[];
  /** Minimum upstream `ttlMs`, default 60,000 (6.7). */
  ttlMs: number;
  cacheScope: 'private';
  /** What the cache needs to match invalidation events (4.3). */
  dependencies: { installationIds: string[]; catalogEntryIds: string[]; teamIds: string[] };
};

export type { FinalPrompt, FinalTool, ResourceRoute };
