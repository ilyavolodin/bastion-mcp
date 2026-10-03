/**
 * Shapes shared by the apply, call and preview modules: upstream definitions in, final
 * definitions plus call-time plans out. The router stores the plans in its routing table.
 */
import type {
  AddedResource,
  AddedResourceTemplate,
  JsonObject,
  JsonValue,
  MessagesTransform,
  OutputTransform,
  OverridesDocument,
} from './schema';

/** The catalog layer (12.1) and the installation layer, either of which may be absent. */
export type OverrideLayers = {
  catalog?: OverridesDocument | undefined;
  installation?: OverridesDocument | undefined;
};

export type UpstreamTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
} & Record<string, unknown>;

export type UpstreamPromptArgument = {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
} & Record<string, unknown>;

export type UpstreamPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments?: UpstreamPromptArgument[];
  _meta?: Record<string, unknown>;
} & Record<string, unknown>;

export type UpstreamResource = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
} & Record<string, unknown>;

export type UpstreamResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
} & Record<string, unknown>;

/** A non-fatal observation about an override; surfaced by the editor (12.5). */
export type OverrideIssue = { code: string; message: string; path?: string };

export type HiddenItem = { kind: 'hidden' };

/** The item cannot be served: withheld and marked degraded (12.3). */
export type InvalidItem = {
  kind: 'invalid';
  degraded: true;
  error: string;
  issues: OverrideIssue[];
};

export type ToolPlan = {
  upstreamName: string;
  /** Pinned values; strings may hold value templates resolved per call by `resolvePinned`. */
  pinned: Record<string, JsonValue>;
  defaults: Record<string, JsonValue>;
  /** Final input schema, used to validate when `validate` is set. */
  schema: JsonObject;
  /** True when the tool has pinned arguments or an applied schema patch (12.3). */
  validate: boolean;
  outputTransform?: OutputTransform;
  timeoutMs?: number;
  guardProfileId?: string | null;
};

export type FinalTool = {
  kind: 'tool';
  upstreamName: string;
  /** Exact final name set by an override: suppresses prefixing (pass to `resolveNames`). */
  exactName?: string;
  tool: UpstreamTool;
  plan: ToolPlan;
  /** The schema patch was invalid and was not applied; the rest of the override was (12.3). */
  invalid?: { field: 'inputSchemaPatch'; error: string };
  issues: OverrideIssue[];
};

export type PromptPlan = {
  upstreamName: string;
  pinned: Record<string, string>;
  hidden: string[];
  messagesTransform?: MessagesTransform;
};

export type FinalPrompt = {
  kind: 'prompt';
  upstreamName: string;
  exactName?: string;
  prompt: UpstreamPrompt;
  plan: PromptPlan;
  issues: OverrideIssue[];
};

/** A resource or template Bastion answers itself (12.2 `added`): no upstream read happens. */
export type HostedRead =
  | { kind: 'resource'; def: AddedResource }
  | { kind: 'template'; uriTemplate: string; def: AddedResourceTemplate };

/** How a read is mapped back upstream. */
export type ResourceRoute =
  | { kind: 'resource'; prefixSlug?: string; hosted?: HostedRead }
  | {
      kind: 'template';
      upstreamTemplate: string;
      pinnedVariables: Record<string, string>;
      prefixSlug?: string;
      hosted?: HostedRead;
    };

export type FinalResource = {
  kind: 'resource';
  upstreamUri: string;
  resource: UpstreamResource;
  route: ResourceRoute;
  issues: OverrideIssue[];
};

export type FinalResourceTemplate = {
  kind: 'resourceTemplate';
  upstreamTemplate: string;
  template: UpstreamResourceTemplate;
  route: ResourceRoute;
  issues: OverrideIssue[];
};

export type ApplyResult<T> = T | HiddenItem | InvalidItem;
