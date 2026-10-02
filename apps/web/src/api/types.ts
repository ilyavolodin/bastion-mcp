/**
 * DTOs of the control-plane REST API (17.2). Written by hand from the spec and the data model until
 * `@bastion-mcp/api-client` is generated from the OpenAPI document; swapping is a one-file change in
 * `src/api` (see README). Closed sets come from `@bastion-mcp/core` constants.
 */
import type {
  CALL_OUTCOMES,
  CATALOG_KINDS,
  CATALOG_STATUSES,
  DRIFT_POLICIES,
  INSTALLATION_STATUSES,
  ITEM_KINDS,
  MARKETPLACE_ITEM_POLICIES,
  ORG_ROLES,
  POLICY_EFFECTS,
  RISK_LEVELS,
  TEAM_ROLES,
} from '@bastion-mcp/core/constants';

export type Page<T> = { items: T[]; nextCursor: string | null };

export type OrgRole = (typeof ORG_ROLES)[number];
export type TeamRole = (typeof TEAM_ROLES)[number];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ItemKind = (typeof ITEM_KINDS)[number];
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];
export type DriftPolicy = (typeof DRIFT_POLICIES)[number];
export type MarketplaceItemPolicy = (typeof MARKETPLACE_ITEM_POLICIES)[number];

/** The role the UI reasons about (10.1): "Manager" is a member who manages at least one team. */
export type UiRole = 'admin' | 'manager' | 'member' | 'auditor';
export type ThemePref = 'light' | 'dark';

export type TeamRef = { id: string; name: string; role: TeamRole };

export type Me = {
  id: string;
  email: string;
  name: string;
  orgRole: OrgRole;
  teams: TeamRef[];
  theme: ThemePref;
  org: { name: string; host: string; traceUiUrl: string | null; toolWarnThreshold: number };
  /** Cedar-derived capability flags the UI cannot infer from the role alone (10.1, 11.7). */
  capabilities: {
    registry: boolean;
    publishOrgWide: boolean;
    personalInstalls: 'off' | 'remoteOnly' | 'all';
  };
};

export type Notification = {
  id: string;
  kind: 'install_request' | 'drift' | 'setup' | 'approval' | 'info';
  title: string;
  body: string;
  href: string | null;
  createdAt: string;
  readAt: string | null;
};

export type Quota = {
  id: string;
  name: string;
  used: number;
  limit: number;
  /** `left`: the bar shows what is left of a budget (quota); `inUse`: it shows concurrency. */
  mode: 'left' | 'inUse';
};

export type RuntimeKind = 'remote' | 'npm' | 'python' | 'oci';
export type AuthMode = 'oauth' | 'userSecret' | 'teamSecret' | 'none';
export type IsolationLevel = 'none' | 'namespaces' | 'gvisor';

export type Installation = {
  id: string;
  slug: string;
  toolPrefix: string;
  displayName: string;
  letter: string;
  color: string;
  catalogEntryId: string | null;
  versionLabel: string;
  package: string | null;
  runtime: RuntimeKind;
  authMode: AuthMode;
  isolation: IsolationLevel;
  ownerType: 'user' | 'team' | 'service';
  ownerName: string;
  origin: string;
  enabled: boolean;
  hidden: boolean;
  pinnedVersion: boolean;
  status: InstallationStatus;
  statusDetail: string | null;
  canManage: boolean;
  spark24: number[];
  endpointUrl: string;
  toolCount: number;
  secrets: { name: string; set: boolean }[];
  oauth: { provider: string; scopes: string[]; expiresAt: string | null; connected: boolean } | null;
  updatedAt: string;
};

export type InstallationInput = {
  entrySlug: string;
  variables: Record<string, string>;
  toolPrefix?: string;
};

export type InstallationPatch = Partial<
  Pick<Installation, 'slug' | 'toolPrefix' | 'displayName' | 'enabled' | 'hidden' | 'pinnedVersion'>
>;

export type StoreEntry = {
  id: string;
  slug: string;
  kind: CatalogKind;
  displayName: string;
  description: string;
  letter: string;
  color: string;
  category: string;
  tags: string[];
  runtime: RuntimeKind;
  authMode: AuthMode;
  isolation: IsolationLevel;
  installCount: number;
  popularity: number;
  installed: boolean;
  version: string;
  publisher: string;
  risk: RiskLevel;
};

export type CapabilityItem = {
  kind: ItemKind;
  name: string;
  description: string;
  access?: 'read' | 'write' | 'destructive';
};

export type FormField = {
  name: string;
  label: string;
  help?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  placeholder?: string;
};

export type StoreEntryDetail = StoreEntry & {
  summary: string;
  items: CapabilityItem[];
  setup: { oauthProvider: string | null; needsApiKey: boolean; settings: number };
  egressHosts: string[];
  guards: string[];
  versions: { label: string; publishedAt: string; note: string }[];
  form: { variables: FormField[]; secrets: FormField[] };
  canEdit: boolean;
};

export type EffectiveCapability = CapabilityItem & {
  finalName: string;
  overridden: boolean;
  hidden: boolean;
  guarded: boolean;
};

export type EgressHost = {
  host: string;
  status: 'allowed' | 'denied';
  reason: string;
  lastSeenAt: string | null;
};

export type EgressRequest = {
  id: string;
  host: string;
  status: 'open' | 'approved' | 'rejected';
  reason: string;
};

export type Endpoint = {
  id: string;
  slug: string;
  name: string;
  url: string;
  isDefault: boolean;
  installationIds: string[];
  toolCount: number;
  updatedAt: string;
};
export type EndpointInput = { name: string; installationIds: string[] };

export type ClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode';
export type ClientConfig = {
  client: ClientId;
  label: string;
  format: 'json' | 'command';
  content: string;
  filename: string | null;
  instructions: string;
};

export type ConnectResult = { url: string };

// --- Overrides (12) -----------------------------------------------------------------------------
export type OverrideDocument = {
  version: 1;
  uriPrefix?: boolean;
  instructions?: { mode: 'append' | 'replace'; text: string };
  tools?: Record<string, Record<string, unknown>>;
  prompts?: Record<string, Record<string, unknown>>;
  resources?: Record<string, Record<string, unknown>>;
  resourceTemplates?: Record<string, Record<string, unknown>>;
};

export type DefinitionPair = {
  name: string;
  kind: ItemKind;
  upstream: Record<string, unknown>;
  final: Record<string, unknown> | null;
  error: string | null;
};
export type OverridePreview = { definitions: DefinitionPair[]; errors: string[] };
export type TryResult = {
  ok: boolean;
  isError: boolean;
  text: string;
  durationMs: number;
  guard: string | null;
};

// --- Calls and traces (15.5) --------------------------------------------------------------------
export type CallRecord = {
  id: string;
  startedAt: string;
  durationMs: number;
  method: string;
  item: string;
  client: string;
  principalId: string;
  principalName: string;
  teamName: string | null;
  installationId: string | null;
  installationName: string | null;
  outcome: CallOutcome;
  coldStart: boolean;
};

export type TraceSpan = {
  id: string;
  name: string;
  group: 'authn' | 'policy' | 'limits' | 'guard' | 'instance' | 'upstream';
  startMs: number;
  durationMs: number;
  status: 'ok' | 'blocked' | 'error';
  phases?: { name: 'claim' | 'bind' | 'install' | 'spawn' | 'connect'; durationMs: number }[];
};

export type GuardKind = 'prompt_injection' | 'pii' | 'regex' | 'definition_drift';
export type GuardFinding = {
  id: string;
  guard: GuardKind;
  rule: string;
  action: 'block' | 'redact' | 'warn';
  phase: 'request' | 'response' | 'definition';
  before: string;
  match: string;
  after: string;
};

export type CallDetail = CallRecord & {
  totalMs: number;
  traceId: string;
  spans: TraceSpan[];
  findings: GuardFinding[];
  policy: { decision: 'permit' | 'deny'; reasons: { effect: PolicyEffect; rule: string }[] };
  errorMessage: string | null;
  previews: { args: string; result: string } | null;
};

export type CallFilters = {
  userId?: string;
  teamId?: string;
  installationId?: string;
  item?: string;
  outcome?: CallOutcome | '';
  range?: '1h' | '24h' | '7d';
};

// --- Stats (15.5 rollups) -----------------------------------------------------------------------
export type StatsRange = '1h' | '24h' | '7d' | '14d' | '90d';
export type StatsScope = { scope?: 'org' | 'team' | 'me'; teamId?: string; installationId?: string };
export type CallBucket = {
  t: string;
  calls: number;
  errors: number;
  ok: number;
  denied: number;
  blocked: number;
  upstreamError: number;
  coldStarts: number;
};
export type CallSeries = { buckets: CallBucket[]; trend: 'up' | 'down' | 'flat' };
export type FlowStats = {
  clients: string[];
  installations: { id: string; name: string; calls: number; errorRate: number }[];
  links: { client: string; installationId: string; calls: number; errors: number }[];
};
export type LatencyBucket = { t: string; p50: number; p95: number; coldStart: boolean };
export type SandboxPhase = 'claim' | 'bind' | 'install' | 'spawn' | 'connect';
export type SandboxStats = {
  driver: string;
  running: { t: string; count: number }[];
  starts: { phase: SandboxPhase; ms: number }[];
};
export type GuardStats = {
  buckets: { t: string; counts: Record<GuardKind, number> }[];
  topServers: { name: string; count: number }[];
  topTools: { name: string; count: number }[];
};
export type Finding = GuardFinding & {
  callId: string;
  createdAt: string;
  installationName: string;
  tool: string;
};

export type DriftReview = {
  id: string;
  status: 'open' | 'approved' | 'rejected';
  installationId: string;
  serverName: string;
  letter: string;
  color: string;
  itemName: string;
  itemKind: ItemKind;
  risk: RiskLevel;
  createdAt: string;
  approvedVersion: string;
  upstreamVersion: string;
  approved: string;
  upstream: string;
  scan: { verdict: 'clean' | 'suspicious' | 'malicious'; message: string };
  canDecide: boolean;
};

// --- Catalog (11) -------------------------------------------------------------------------------
export type Visibility = { org: boolean; teamIds: string[]; userIds: string[] };
export type CatalogEntry = {
  id: string;
  slug: string;
  kind: CatalogKind;
  displayName: string;
  description: string;
  letter: string;
  color: string;
  status: CatalogStatus;
  risk: RiskLevel;
  ownerTeamId: string | null;
  ownerTeamName: string | null;
  visibility: Visibility;
  currentVersion: string | null;
  draftVersionId: string | null;
  versionCount: number;
  autoUpgrade: boolean;
  source: 'manual' | 'registry' | 'import';
  executable: boolean;
  updatedAt: string;
};

export type SourceSpec = {
  runtime: RuntimeKind;
  package: string;
  version: string;
  command: string;
  args: string[];
  url: string;
  variables: { name: string; label: string; required: boolean; secret: boolean; default: string }[];
  authMode: AuthMode;
  oauthScopes: string[];
  egressHosts: string[];
  isolation: IsolationLevel;
  guardProfileId: string | null;
  limitsProfile: string;
  onDrift: DriftPolicy;
  userOverrides: 'none' | 'cosmetic' | 'full';
  overrides: OverrideDocument;
};

export type CatalogVersionStatus = 'draft' | 'published' | 'broken';
export type TestPhase = { name: SandboxPhase; durationMs: number };
export type TestResult = {
  status: 'running' | 'passed' | 'failed';
  ranAs: string;
  versionLabel: string;
  phases: TestPhase[];
  counts: { tools: number; prompts: number; resources: number; templates: number };
  scan: { item: string; verdict: 'clean' | 'warn' | 'malicious'; message: string }[];
  stderr: string[];
};
export type CatalogVersion = {
  id: string;
  entryId: string;
  label: string;
  status: CatalogVersionStatus;
  spec: SourceSpec;
  test: TestResult | null;
  changelog: string;
  createdAt: string;
  executableApproval: 'none' | 'pending' | 'approved';
};
export type CatalogEntryDetail = CatalogEntry & { versions: CatalogVersion[] };
export type CatalogDraftInput = {
  displayName: string;
  slug: string;
  kind: CatalogKind;
  description: string;
  visibility: Visibility;
  risk: RiskLevel;
  autoUpgrade: boolean;
  spec: SourceSpec;
};

export type TargetChip = { type: 'all' | 'team' | 'role' | 'idpGroup'; id: string; label: string };
export type AutoInstallPolicy = {
  id: string;
  entryId: string;
  entryName: string;
  targets: TargetChip[];
  mode: 'required' | 'default';
  existingUsers: 'applyNow' | 'newOnly';
  scope: 'user' | 'team';
};
export type AutoInstallInput = Omit<AutoInstallPolicy, 'id' | 'entryName'>;
export type AutoInstallPreview = {
  people: number;
  teams: number;
  mustConnect: number;
  sample: { id: string; name: string }[];
};

export type FileNode = { path: string; classification: 'plain' | 'executable'; size: number };
export type SkillFile = { path: string; content: string; classification: 'plain' | 'executable' };

// --- Registry (11.6) ----------------------------------------------------------------------------
export type RegistryServer = {
  sourceId: string;
  sourceName: string;
  name: string;
  version: string;
  description: string;
  runtime: RuntimeKind;
  authMode: AuthMode;
  policy: 'allowed' | 'request' | 'blocked';
  requested: boolean;
};
export type InstallRequest = {
  id: string;
  status: 'open' | 'approved' | 'rejected' | 'cancelled';
  requesterName: string;
  requesterId: string;
  teamName: string | null;
  serverName: string;
  sourceName: string;
  reason: string;
  createdAt: string;
};

// --- Access (10) --------------------------------------------------------------------------------
export type User = {
  id: string;
  name: string;
  email: string;
  orgRole: OrgRole;
  status: 'active' | 'deactivated';
  teams: TeamRef[];
  lastActiveAt: string | null;
  source: 'idp' | 'scim' | 'manual';
};
export type Team = {
  id: string;
  name: string;
  memberCount: number;
  managers: string[];
  members: { userId: string; name: string; role: TeamRole }[];
};
export type RoleMappingRule = {
  id: string;
  idpGroup: string;
  match: 'equals' | 'regex';
  target: 'role' | 'team';
  targetValue: string;
};
export type RoleMappingInput = Omit<RoleMappingRule, 'id'>;
export type ServiceAccount = {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  credentials: number;
  createdAt: string;
};
export type OAuthClient = {
  id: string;
  name: string;
  clientId: string;
  status: 'pending' | 'approved' | 'blocked';
  registration: 'cimd' | 'dcr' | 'preregistered';
  lastUsedAt: string | null;
};
export type RuleChip = { type: string; label: string };
export type PolicyRule = {
  id: string;
  effect: PolicyEffect;
  who: RuleChip[];
  what: RuleChip[];
  when: string[];
  affected: { people: number; tools: number };
  orgLevel: boolean;
  canEdit: boolean;
};
export type PolicyRuleInput = Pick<PolicyRule, 'effect' | 'who' | 'what' | 'when'>;
export type CustomPolicy = { id: string; name: string; cedar: string; enabled: boolean };
export type PolicyValidation = { valid: boolean; errors: { line: number; message: string }[] };
export type SimulationInput = { userId: string; action: string; tool: string };
export type SimulationResult = {
  decision: 'permit' | 'deny';
  summary: string;
  matches: { id: string; effect: PolicyEffect; label: string; deciding: boolean }[];
};

// --- Settings (19.2) ----------------------------------------------------------------------------
export type IdpConnection = {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  domains: string[];
  status: 'ok' | 'error' | 'untested';
  lastTestAt: string | null;
};
export type IdpTestResult = { ok: boolean; steps: { name: string; ok: boolean; detail: string }[] };
export type ModelGuardEntry = { enabled: boolean; endpoint: string; model: string };
export type ModelGuardConfig = {
  jev: ModelGuardEntry;
  llmJudge: ModelGuardEntry;
  classifier: ModelGuardEntry;
};
export type LimitRule = {
  id: string;
  name: string;
  kind: 'rate' | 'quota' | 'concurrency';
  scope: string;
  limit: number;
  window: string;
};
export type SystemStatus = {
  replicas: {
    id: string;
    role: 'worker' | 'ui';
    version: string;
    uptimeSec: number;
    rollingOut: boolean;
  }[];
  queues: { name: string; depth: number; capacity: number }[];
  checks: { name: string; status: 'ok' | 'warn' | 'error'; detail: string }[];
  registrySync: { sourceId: string; name: string; runs: { at: string; ok: boolean }[] }[];
  kms: { provider: string; rotatedAt: string };
};

// --- Plugins (25) -------------------------------------------------------------------------------
export type PluginClientId = 'claude-code' | 'codex' | 'claude-desktop' | 'chatgpt';
export type PluginClientStatus = {
  client: PluginClientId;
  label: string;
  status: 'latest' | 'behind' | 'managed' | 'unknown';
  command: string | null;
  note: string;
};
export type MarketplacePlugin = {
  entryId: string;
  name: string;
  description: string;
  letter: string;
  color: string;
  parts: string[];
  executable: boolean;
  policy: MarketplaceItemPolicy;
  state: 'installed' | 'available' | 'update';
};
export type Marketplace = {
  id: string;
  slug: string;
  name: string;
  owner: string;
  ownedByTeam: boolean;
  plugins: MarketplacePlugin[];
  clients: PluginClientStatus[];
  canManage: boolean;
};
export type MarketplaceRelease = {
  n: number;
  createdAt: string;
  promoted: boolean;
  draft: boolean;
  commit: string;
};
export type MarketplaceDetail = Marketplace & {
  releases: MarketplaceRelease[];
  mirror: { status: 'in_sync' | 'behind' | 'failed'; target: string; lastPushAt: string | null };
  adoption: { release: 'latest' | 'oneBehind' | 'older'; people: number }[];
  desktopInstallation: 'available' | 'auto_install' | 'required';
};
export type RolloutConfig = {
  client: string;
  label: string;
  kind: 'snippet' | 'checklist';
  content: string;
};
export type ExecutableApproval = {
  entryId: string;
  versionId: string;
  name: string;
  letter: string;
  color: string;
  author: string;
  summary: string;
  diff: string[];
};

export type ServerEvent =
  | { type: 'notification'; data: Notification }
  | { type: 'installation.status'; data: { id: string; status: InstallationStatus } }
  | {
      type: 'test.progress';
      data: { entryId: string; versionId: string; status: TestResult['status'] };
    }
  | { type: 'drift.review'; data: { id: string } };
