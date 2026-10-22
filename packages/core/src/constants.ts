/**
 * Shared constants. Single source of truth for values that appear in more than one package:
 * protocol versions (6.1), error codes (6.9), Redis keys and channels (16.3), default limits (14.3)
 * and the closed sets that the database constrains with CHECK clauses (16.2).
 */

export const PROTOCOL_VERSIONS = {
  modern: ['2026-07-28'],
  legacy: ['2025-11-25', '2025-06-18', '2025-03-26'],
  /** A request without MCP-Protocol-Version is treated as this revision (6.1). */
  default: '2025-03-26',
} as const;

export type Era = 'modern' | 'legacy';

/** Bastion's own `_meta` keys always use this prefix (6.9). */
export const BASTION_META_PREFIX = 'io.github.bastion-mcp/';
export const metaKey = (name: string): string => `${BASTION_META_PREFIX}${name}`;
export const META_KEYS = {
  error: metaKey('error'),
  guard: metaKey('guard'),
  limits: metaKey('limits'),
  degraded: metaKey('degraded'),
  needsAuth: metaKey('needsAuth'),
  onBehalfOf: metaKey('onBehalfOf'),
  registry: metaKey('registry'),
} as const;

/** Bastion-defined JSON-RPC codes, implementation range -32000..-32019 (6.9). */
export const ERROR_CODES = {
  POLICY_DENIED: -32010,
  RATE_LIMITED: -32011,
  QUOTA_EXCEEDED: -32012,
  GUARD_BLOCKED: -32013,
  UPSTREAM_UNAVAILABLE: -32014,
  UPSTREAM_AUTH_REQUIRED: -32015,
  SANDBOX_START_FAILED: -32016,
  UPSTREAM_TIMEOUT: -32017,
} as const;

/** Standard JSON-RPC codes Bastion also emits. */
export const JSONRPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const MAX_UPSTREAM_ERROR_MESSAGE = 2000;

// --- Closed sets (mirrored by CHECK constraints in the database, verified by a db test) -------------
export const ORG_ROLES = ['admin', 'auditor', 'member'] as const;
export const TEAM_ROLES = ['manager', 'member'] as const;
export const MEMBERSHIP_SOURCES = ['manual', 'idp', 'scim'] as const;
export const USER_STATUSES = ['active', 'deactivated'] as const;
export const PRINCIPAL_TYPES = ['user', 'service'] as const;
export const OWNER_TYPES = ['user', 'team', 'service'] as const;
export const SECRET_SCOPES = ['org', 'team', 'user', 'system'] as const;
export const SIGNING_KEY_PURPOSES = ['as', 'upstream-client'] as const;
export const CATALOG_KINDS = ['mcp_server', 'skill', 'plugin', 'tool'] as const;
export const CATALOG_STATUSES = ['draft', 'published', 'deprecated', 'archived'] as const;
export const CATALOG_VERSION_STATUSES = ['draft', 'published', 'broken'] as const;
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const USER_OVERRIDE_LEVELS = ['none', 'cosmetic', 'full'] as const;
export const DRIFT_POLICIES = ['hideChanged', 'block', 'warn'] as const;
export const ITEM_KINDS = ['tool', 'prompt', 'resource', 'template'] as const;
export const REVIEW_STATUSES = ['open', 'approved', 'rejected'] as const;
export const REQUEST_STATUSES = ['open', 'approved', 'rejected', 'cancelled'] as const;
export const INSTALLATION_STATUSES = [
  'ready',
  'needs_setup',
  'reconnect_required',
  'error',
  'disabled',
] as const;
export const INSTANCE_KINDS = ['remote-legacy', 'sandbox'] as const;
export const UPSTREAM_TOKEN_STATUSES = ['valid', 'reconnect_required'] as const;
export const POLICY_EFFECTS = ['permit', 'forbid'] as const;
export const LIMIT_KINDS = ['rate', 'quota', 'concurrency'] as const;
export const AUTO_INSTALL_MODES = ['required', 'default'] as const;
export const AUTO_INSTALL_SCOPES = ['user', 'team'] as const;
export const FILE_MODES = ['file', 'executable'] as const;
export const FILE_CLASSIFICATIONS = ['plain', 'executable'] as const;
export const MARKETPLACE_ITEM_POLICIES = ['available', 'installedByDefault', 'required'] as const;
export const DESKTOP_INSTALLATION_MODES = ['available', 'auto_install', 'required'] as const;
export const DISTRIBUTION_CHANNELS = ['git', 'https', 'mirror'] as const;
export const CALL_OUTCOMES = [
  'ok',
  'tool_error',
  'error',
  'blocked',
  'denied',
  'rate_limited',
  'input_required',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

// --- Tokens and prefixes ------------------------------------------------------------------------------
export const TOKEN_PREFIXES = {
  pat: 'bst_pat_',
  requestState: 'bst1.',
  taskId: 'btk1.',
  listCursor: 'bcur1.',
  progress: 'pt_',
} as const;

export const SCOPES = {
  mcp: 'mcp',
  apiRead: 'api:read',
  apiWrite: 'api:write',
  pluginsRead: 'plugins:read',
  offlineAccess: 'offline_access',
} as const;

// --- Timings (seconds unless named) ------------------------------------------------------------------------
export const TTL = {
  legacySession: 30 * 60,
  uiSession: 12 * 60 * 60,
  uiSessionAbsolute: 7 * 24 * 60 * 60,
  lease: 15,
  leaseRenewInterval: 5,
  startSingleFlight: 120,
  continuation: 10 * 60,
  pendingResponse: 10 * 60,
  eraCache: 24 * 60 * 60,
  uriSeen: 24 * 60 * 60,
  riskScore: 2 * 60 * 60,
  guardCache: 24 * 60 * 60,
  revoked: 24 * 60 * 60,
  sandboxLogs: 24 * 60 * 60,
  workerRegistry: 15,
  idempotency: 24 * 60 * 60,
  configCache: 60,
  requestState: 10 * 60,
  accessToken: 15 * 60,
  principalCache: 60,
  jwksCache: 10 * 60,
  patCache: 60,
} as const;

// --- Redis keys and channels (16.3) --------------------------------------------------------------------------
export const redisKeys = {
  session: (sessionId: string) => `sess:${sessionId}`,
  sessionList: (principalId: string) => `sesslist:${principalId}`,
  uiSession: (id: string) => `uisess:${id}`,
  lease: (instanceId: string) => `lease:${instanceId}`,
  start: (instanceId: string) => `start:${instanceId}`,
  continuation: (continuationId: string) => `cont:${continuationId}`,
  pendingResponse: (sessionId: string, rpcId: string | number) => `pend:${sessionId}:${rpcId}`,
  era: (installationId: string, credentialHash: string) =>
    `era:${installationId}:${credentialHash}`,
  listCache: (installationId: string, credentialHash: string, method: string) =>
    `lc:${installationId}:${credentialHash}:${method}`,
  uriSeen: (principalId: string, endpointId: string) => `uriseen:${principalId}:${endpointId}`,
  rate: (ruleId: string, subjectId: string) => `rl:${ruleId}:${subjectId}`,
  quota: (ruleId: string, subjectId: string, period: string) =>
    `q:${ruleId}:${subjectId}:${period}`,
  concurrency: (ruleId: string, subjectId: string) => `conc:${ruleId}:${subjectId}`,
  risk: (principalId: string, clientId: string) => `risk:${principalId}:${clientId}`,
  guardCache: (guardInstanceId: string, configHash: string, textSha256: string) =>
    `guard:${guardInstanceId}:${configHash}:${textSha256}`,
  revoked: (principalId: string) => `revoked:${principalId}`,
  sandboxLogs: (instanceId: string) => `logs:${instanceId}`,
  listenRefs: (installationId: string, credentialHash: string) =>
    `listen:${installationId}:${credentialHash}`,
  listenLease: (installationId: string, credentialHash: string) =>
    `ulisten:${installationId}:${credentialHash}`,
  worker: (workerId: string) => `workers:${workerId}`,
  egress: (instanceId: string) => `egress:${instanceId}`,
  inflight: (instanceId: string) => `inflight:${instanceId}`,
  idempotency: (principalId: string, key: string) => `idem:${principalId}:${key}`,
  upstreamStepUp: (principalId: string, installationId: string) =>
    `ups:stepup:${principalId}:${installationId}`,
  /** Set when an upstream AS refused our CIMD identity; `auto` registration then uses DCR for that issuer. */
  upstreamCimdRejected: (issuer: string) => `ups:cimdrej:${issuer}`,
} as const;

export const REDIS_CHANNELS = {
  config: 'bastion:config',
  notify: 'bastion:notify',
  revoke: 'bastion:revoke',
  listen: 'bastion:listen',
  session: (sessionId: string) => `bastion:sess:${sessionId}`,
} as const;

// --- Defaults ----------------------------------------------------------------------------------------------------
/** Default limit rules (14.3). */
export const DEFAULT_LIMIT_RULES = {
  userCalls: { points: 600, perSeconds: 60, burst: 100 },
  userConcurrency: { max: 20, leaseSeconds: 900 },
  serviceAccountCalls: { points: 3000, perSeconds: 60, burst: 500 },
  userRunningSandboxes: 10,
  userSamplingPerDay: 200,
} as const;

/** Pre-auth per-IP flood limits per minute (14.2). */
export const FLOOD_LIMITS = { mcpPerMinute: 1000, oauthPerMinute: 60 } as const;

/** Timeouts in milliseconds (6.4, 6.5, 8.6). */
export const TIMEOUTS_MS = {
  toolCall: 60_000,
  list: 15_000,
  maxOverride: 30 * 60_000,
  continuationDebounce: 25,
  instanceListWait: 20_000,
  graceful: 25_000,
} as const;

export const FAILURE_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const MAX_INPUT_ROUNDS = 10;
export const MAX_LIST_ITEMS_PER_INSTALLATION = 10_000;
export const MAX_INSTRUCTIONS_CHARS = 8_000;
export const MAX_UPSTREAM_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_UPSTREAM_STREAM_BYTES = 100 * 1024 * 1024;

export const SANDBOX_SIZES = {
  small: { cpuRequest: 0.25, cpuLimit: 1, memoryMiB: 512 },
  medium: { cpuRequest: 0.5, cpuLimit: 2, memoryMiB: 1024 },
  large: { cpuRequest: 1, cpuLimit: 4, memoryMiB: 4096 },
} as const;
export type SandboxSize = keyof typeof SANDBOX_SIZES;

export const PLUGIN_LIMITS = {
  maxUnpackedBytes: 20 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 5 * 1024 * 1024,
} as const;

/** Duration units in milliseconds; use instead of re-deriving `60 * 60 * 1000`. */
export const MS = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
  WEEK: 604_800_000,
} as const;

/** Duration units in seconds. */
export const SECONDS = { MINUTE: 60, HOUR: 3_600, DAY: 86_400, WEEK: 604_800 } as const;

/** Client id of the first-party web UI. */
export const UI_CLIENT_ID = 'bastion-ui';

/** Auth methods a service account may use at the token endpoint. */
export const AUTH_METHODS = ['client_secret_basic', 'private_key_jwt'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Custom HTTP header names. */
export const HEADERS = {
  release: 'x-bastion-release',
  signature: 'x-bastion-signature',
  csrf: 'x-bastion-csrf',
  dropped: 'x-bastion-dropped',
} as const;

/** Daily partitions kept ahead of today for call_log, egress_events and distribution_events (15.5). */
export const PARTITION_DAYS_AHEAD = 7;

/** `origin` of the hidden installations the catalog TEST flow creates (11.3). */
export const TEST_ORIGIN = 'test';

/** Name Bastion reports as `serverInfo.name` and uses for its own hosted items. */
export const SERVER_NAME = 'bastion';

/** Methods whose result may be `input_required` and that stream on the 2025 transport (6.5). */
export const CONTINUABLE_METHODS: ReadonlySet<string> = new Set([
  'tools/call',
  'prompts/get',
  'resources/read',
]);
