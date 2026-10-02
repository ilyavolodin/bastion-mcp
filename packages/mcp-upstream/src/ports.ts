/**
 * Ports of `mcp-upstream` (CONTRIBUTING rule 6): everything the package needs from Redis, Postgres, the auth
 * package and the platform is an interface here; `apps/server` wires the implementations.
 */
import type { Era, Injection, ServerSpec, TemplateContext } from '@bastion-mcp/core';
import type { EgressPolicy, EgressPolicyStore } from '@bastion-mcp/sandbox';

// --- Redis ----------------------------------------------------------------------------------------------------

/**
 * The subset of an `ioredis` 5.x client used here. Values are strings. `set` takes the raw option tokens
 * (`'PX', 15000, 'NX'`), `eval` runs the Lua scripts of `ownership/lua`.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...options: (string | number)[]): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  hset(key: string, data: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
}

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};
export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// --- who is calling -------------------------------------------------------------------------------------------

export type CallPrincipal = {
  userId: string;
  type?: 'user' | 'service';
  clientName?: string;
  email?: string;
  teams?: string[];
};

// --- installations --------------------------------------------------------------------------------------------

/** Everything the upstream layer needs to know about one installation (or shared pool member). */
export type ResolvedInstallation = {
  /** Null never happens for callers: shared instances are reached through a user's installation. */
  installationId: string;
  slug: string;
  catalogEntryId: string;
  catalogVersionId: string;
  /** `bastion.catalog.entry` metric/span value; `personal` for personal installations (15.3). */
  catalogEntryName: string;
  /** Admin-authored entries may reach `BASTION_PRIVATE_UPSTREAM_CIDRS`; personal ones never (8.9). */
  origin: 'admin' | 'personal';
  ownerUserId: string | null;
  spec: ServerSpec;
  /** Non-secret installation variables (`{{var.NAME}}`). */
  variables: Record<string, string>;
  /** Snapshot key (7.5), see router `computeConfigHash`. */
  configHash: string;
  /** Catalog flags: the entry enables sampling and roots bridging (6.4). */
  enableSampling: boolean;
  enableRoots: boolean;
  /** Configured roots; default `[]` for remotes, `file:///workspace` for sandboxes (6.5). */
  roots: string[];
  /** Per-entry extension allow and block lists (6.8). */
  extensions: { allow?: string[]; block?: string[] };
  /** Shared pool size, 1 to 10 (8.6). */
  replicas: number;
  /** Seconds-scale upstream-specific overrides come from `spec.timeouts`. */
  /** Redis `lc:` TTL when the upstream sends no `ttlMs` (6.7). Defaults to the service setting. */
  listTtlMs?: number;
};

export interface InstallationRegistry {
  get(installationId: string): Promise<ResolvedInstallation | null>;
}

// --- credentials ----------------------------------------------------------------------------------------------

export type ResolvedCredential = {
  /** Header, env and argument injections (9.5); `value` is a template resolved with `templateContext`. */
  injections: Injection[];
  /** Stable digest identifying the credential, never the secret (6.4 era cache, 6.7 list cache keys). */
  credentialHash: string;
  /** Values for `{{secret.X}}` and `{{oauth.accessToken}}` references. */
  templateContext?: Pick<TemplateContext, 'secret' | 'oauth'>;
};

/** Raised by an `UpstreamCredentialProvider` when no usable credential exists (9.5, 6.5 last paragraph). */
export class AuthRequiredError extends Error {
  constructor(message = 'upstream credential required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * Port: the auth package's `UpstreamCredentialResolver` is adapted to this. Throws `AuthRequiredError` when the
 * user has no usable credential; the service converts it into `UpstreamAuthRequiredError` (-32015).
 */
export interface UpstreamCredentialProvider {
  resolve(
    principal: CallPrincipal,
    installation: ResolvedInstallation,
    spec: ServerSpec,
  ): Promise<ResolvedCredential>;
}

/** Builds `https://<bastion>/connect/<installationId>?state=...` for `-32015` errors (6.5). */
export interface ConnectUrlBuilder {
  connectUrl(principal: CallPrincipal, installationId: string): string | Promise<string>;
}

// --- instances (Postgres) ---------------------------------------------------------------------------------------

export type InstanceKind = 'remote-legacy' | 'sandbox';

export type RemoteSessionRecord = {
  sessionId: string;
  protocolVersion: string;
  url: string;
  serverCapabilities?: Record<string, unknown> | undefined;
};

/** One `instances` row (8.6, 16.2). `installationId` is null for shared pool members. */
export type InstanceRecord = {
  id: string;
  installationId: string | null;
  catalogVersionId: string;
  userId: string | null;
  kind: InstanceKind;
  /** Pool member number for shared instances (0-based); 0 otherwise. */
  replica: number;
  sandbox?: { driver: 'kubernetes' | 'bubblewrap'; id: string; address: string } | undefined;
  remoteSession?: RemoteSessionRecord | undefined;
  startedAt?: number | undefined;
  lastUsedAt: number;
  /** Failure timestamps within the last 30 minutes (8.6). */
  failures: number[];
  /** Set after three failures in 30 minutes: shown in the UI (8.6). */
  error?: { phase: string; message: string; stderrTail: string[]; at: number } | undefined;
  /** Catalog version the running process was started from (version change, 8.6). */
  runningVersionId?: string | undefined;
};

export interface InstanceRepository {
  get(instanceId: string): Promise<InstanceRecord | null>;
  getForInstallation(installationId: string): Promise<InstanceRecord | null>;
  /** Shared pool members of a catalog version (installation_id null). */
  listShared(catalogVersionId: string): Promise<InstanceRecord[]>;
  save(record: InstanceRecord): Promise<void>;
  /** Sandboxes that are currently running or starting, optionally for one user (limits, 8.6). */
  listRunning(userId?: string): Promise<InstanceRecord[]>;
  delete(instanceId: string): Promise<void>;
}

/** The instance's runner token, stored ENCRYPTED so a new owner can `driver.attach` (21.2, 22.3). */
export interface RunnerTokenStore {
  save(instanceId: string, runnerToken: string): Promise<void>;
  load(instanceId: string): Promise<string | null>;
  delete(instanceId: string): Promise<void>;
}

/** Marks installations `error` or clears it, for the UI (8.6). */
export interface InstallationStatusSink {
  markError(
    installationId: string,
    detail: { phase: string; message: string; stderrTail: string[] },
  ): Promise<void>;
  clearError(installationId: string): Promise<void>;
}

// --- snapshots (Postgres) ---------------------------------------------------------------------------------------

export type SnapshotItems = {
  tools: unknown[];
  prompts: unknown[];
  resources: unknown[];
  resourceTemplates: unknown[];
  instructions?: string | undefined;
  serverInfo?: { name: string; version: string; title?: string } | undefined;
  ttlMs?: number | undefined;
};

/** `upstream_snapshots` keyed by `(installationId, configHash)` (7.5). */
export interface SnapshotStore {
  get(installationId: string, configHash: string): Promise<SnapshotItems | null>;
  /** The catalog entry's reference snapshot for the same `configHash` (11.3). */
  getReference(catalogVersionId: string, configHash: string): Promise<SnapshotItems | null>;
  put(installationId: string, configHash: string, items: SnapshotItems): Promise<void>;
}

/** Emitted when a re-list differs from the stored snapshot (7.5). */
export interface ListChangedPublisher {
  listChanged(installationId: string, kinds: string[]): void | Promise<void>;
}

// --- tool-definition pinning (13.6; implemented with the guards package functions by the caller) -----------------

export type PinCheckResult =
  | { ok: true }
  | { ok: false; changed: string[]; action: 'hideChanged' | 'block' | 'warn' };

export interface PinChecker {
  /** Called with each fresh upstream tool list. Returns drift information; the caller applies the policy. */
  check(installationId: string, tools: unknown[]): Promise<PinCheckResult>;
}

// --- sandbox egress writer (8.8) --------------------------------------------------------------------------------

/** The owner writes `egress:{instanceId}` at start and on every phase change; any worker reads it. */
export interface EgressPolicyWriter extends EgressPolicyStore {
  set(instanceId: string, policy: EgressPolicy): Promise<void>;
  delete(instanceId: string): Promise<void>;
}

export type { Era };
