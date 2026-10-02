/**
 * Ports of `mcp-downstream` (CONTRIBUTING rule 6). `apps/server` provides the implementations; the tests use in-memory
 * fakes of every one.
 */
import type { Principal } from '@bastion-mcp/auth';
import type { ProfileLayers } from '@bastion-mcp/guards';
import type { OperationContext, Rule } from '@bastion-mcp/limits';
import type {
  CallPrincipal,
  UpstreamCallContext,
  JsonObject as UpstreamJsonObject,
  UpstreamOutcome,
} from '@bastion-mcp/mcp-upstream';
import type { PrincipalData } from '@bastion-mcp/policy';
import type { EndpointDefinition, EndpointPolicy, InstallationInfo } from '@bastion-mcp/router';
import type { CallLogRow } from '@bastion-mcp/telemetry';

export type { Clock, Logger } from '@bastion-mcp/mcp-upstream';
export { noopLogger, systemClock } from '@bastion-mcp/mcp-upstream';

// --- identity -----------------------------------------------------------------------------------------------------

/** `TokenVerifier` of `@bastion-mcp/auth` implements this; it throws errors carrying `wwwAuthenticate` (6.9). */
export interface TokenVerifierPort {
  verify(authorization: string | undefined, requestUrl: string): Promise<Principal>;
}

/** Optional profile data the verified `Principal` does not carry (email for templates, email domain for Cedar). */
export interface PrincipalProfilePort {
  profile(
    principal: Principal,
  ): Promise<{ email?: string | undefined; emailDomain?: string | undefined }>;
}

// --- endpoints (7.1, 7.2) -----------------------------------------------------------------------------------------

/** What the worker loads on an endpoint cache miss; `apps/server` backs it with `packages/db`. */
export type EndpointData = {
  /** Every installation the principal could use: their own and their teams' (11.4). */
  installations: readonly InstallationInfo[];
  namedEndpoints: readonly EndpointDefinition[];
  /** `installation_prefs.hidden` for this principal (11.4). */
  hiddenInstallationIds?: readonly string[];
};

export interface EndpointDataPort {
  /** Cheap: the current `config_version`, part of the endpoint cache key (4.3). */
  configVersion(): string | Promise<string>;
  load(principal: Principal, signal?: AbortSignal): Promise<EndpointData>;
}

export interface PolicyPort {
  /** The current compiled policy engine (`PolicyEngine` implements `EndpointPolicy`). */
  current(): EndpointPolicy;
}

/** Builds the Cedar principal from the verified one; the default derives it from `Principal` alone. */
export type ToPolicyPrincipal = (
  principal: Principal,
  profile: { emailDomain?: string | undefined },
) => PrincipalData;

// --- limits (14) -------------------------------------------------------------------------------------------------

export interface LimitRulesPort {
  /** The rules that can match this caller on this endpoint (14.1, compiled with `compileRulesFor`). */
  rulesFor(op: OperationContext, endpoint: { installationIds: readonly string[] }): readonly Rule[];
}

// --- guards (13) -------------------------------------------------------------------------------------------------

export interface GuardProfilePort {
  /** Org default, catalog version and tool-level profiles for an operation (13.1). */
  layersFor(input: {
    installationId: string;
    catalogEntryId?: string | undefined;
    catalogVersionId?: string | undefined;
    /** `ToolPlan.guardProfileId` of an override, when one exists. */
    toolProfileId?: string | null | undefined;
  }): ProfileLayers;
}

// --- call log (15.5) ------------------------------------------------------------------------------------------------

/** `CallLogWriter` of `@bastion-mcp/telemetry` implements this. Never throws, never blocks. */
export interface CallLogPort {
  append(row: CallLogRow): void;
}

// --- skills (6.8, 25.8) ---------------------------------------------------------------------------------------------

export type SkillRef = { uri: string } | { plugin: string; name: string };
type JsonObjectLike = Record<string, unknown>;

/** The plugins package backs this with `listSkills`, `getSkill` and `readSkillResource` over the caller's marketplaces. */
export interface SkillsProvider {
  list(principal: Principal): Promise<JsonObjectLike>;
  get(principal: Principal, ref: SkillRef): Promise<JsonObjectLike | undefined>;
  /** `resources/read` for `skill://` URIs; undefined when the skill is not visible to the caller. */
  readResource(principal: Principal, uri: string): Promise<JsonObjectLike | undefined>;
}

// --- /mcp/c/{catalogSlug} (7.1, 25.8) -----------------------------------------------------------------------------

export interface CatalogInstallPort {
  /**
   * Applies the `resolveCatalogRoute` rules: the caller's own installation, then a team one, otherwise a visible entry
   * gets a user installation (`origin = plugin`), `needs_setup` when it requires setup. `created` tells the HTTP layer
   * to drop the caller's cached endpoints.
   */
  ensure(
    principal: Principal,
    catalogSlug: string,
  ): Promise<{ status: 'ok'; created: boolean } | { status: 'not_found' }>;
}

// --- upstream (6.4, 6.5, 6.6) ---------------------------------------------------------------------------------------

export type ResourceSubscription = {
  installationId: string;
  principal: CallPrincipal;
  downstreamUri: string;
  endpointId: string;
  signal?: AbortSignal | undefined;
};

/** `UpstreamService` implements `execute` and `executeTask`; `upstreamPortFrom` adds subscriptions over `ListenManager`. */
export interface UpstreamPort {
  execute(request: {
    installationId: string;
    method: string;
    params: UpstreamJsonObject;
    ctx: UpstreamCallContext;
  }): Promise<UpstreamOutcome>;
  executeTask(request: {
    method: string;
    params: UpstreamJsonObject;
    ctx: UpstreamCallContext;
  }): Promise<UpstreamOutcome>;
  /** Registers a downstream resource subscription with the installation's owner (6.6). */
  subscribeResource(args: ResourceSubscription): Promise<void>;
  unsubscribeResource(args: ResourceSubscription): Promise<void>;
  /** A downstream stream wants list changes of an installation (reference count, 6.6). */
  joinListen(args: { installationId: string; principal: CallPrincipal }): Promise<void>;
  leaveListen(args: { installationId: string; principal: CallPrincipal }): Promise<void>;
}

// --- Redis (6.2 sessions, 6.5 pend, 6.6 pub/sub) ----------------------------------------------------------------------

/** The subset of an `ioredis` 5.x client used here; a real `Redis` is assignable (checked by a test). */
export interface DownstreamRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hset(key: string, data: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hget(key: string, field: string): Promise<string | null>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  /** A dedicated connection for SUBSCRIBE. */
  duplicate(): RedisSubscriber;
}

export interface RedisSubscriber {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

// --- replica-to-replica (21.2) ---------------------------------------------------------------------------------------

export interface WorkerDirectory {
  readonly workerId: string;
  lookup(workerId: string): Promise<{ address: string } | null>;
}

/** `InternalRpcClient.forwardSessionResponse` of `mcp-upstream` implements this. */
export interface SessionResponseForwarder {
  forwardSessionResponse(
    address: string,
    sessionId: string,
    message: unknown,
    signal?: AbortSignal,
  ): Promise<void>;
}
