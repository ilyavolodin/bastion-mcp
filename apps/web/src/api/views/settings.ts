/**
 * Settings and system: what the screens derive from the generated API types (`Schemas[...]`, `Res<...>`).
 * Nothing here restates a body; these are pure mappers between API rows and the values forms edit.
 */
import type { Body, Res, Schemas } from '../schema';

export type OrgSettings = Res<'get', '/settings'>['settings'];
export type LimitRule = Schemas['LimitRule'];
export type IdpConnection = Schemas['IdpConnection'];
export type ModelGuards = Schemas['ModelGuards'];
export type SystemStatus = Res<'get', '/system/status'>;
export type IdpTestResult = Res<'post', '/idp-connections/{id}/test'>;

// --- limit rules (14) ---------------------------------------------------------------------------------------------

export const LIMIT_SUBJECTS = ['user', 'team', 'role', 'serviceAccount', 'org', 'client'] as const;
export const LIMIT_METRICS = ['calls', 'bytesOut', 'samplingRequests', 'modelGuardTokens'] as const;
export const LIMIT_PERIODS = ['day', 'week', 'month'] as const;
export const LIMIT_ACTIONS = ['reject', 'warn'] as const;

export const SUBJECT_LABEL: Record<LimitRule['subject'], string> = {
  user: 'Each user',
  team: 'Each team',
  role: 'Each role',
  serviceAccount: 'Each service account',
  org: 'The whole organization',
  client: 'Each client',
};

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** `5,000 per day`, `60 per minute (burst 10)` or `8 at once`: the parameters of a rule in words. */
export const describeLimit = (rule: LimitRule): string => {
  const p = rule.params;
  if (rule.kind === 'quota')
    return `${num(p.points).toLocaleString('en-US')} per ${String(p.period)}`;
  if (rule.kind === 'concurrency') return `${num(p.max).toLocaleString('en-US')} at once`;
  const secs = num(p.perSeconds);
  const per = secs === 60 ? 'minute' : secs === 3600 ? 'hour' : secs === 1 ? 'second' : `${secs} s`;
  const burst = num(p.burst) > 0 ? ` (burst ${num(p.burst)})` : '';
  return `${num(p.points).toLocaleString('en-US')} per ${per}${burst}`;
};

/** Who and what a rule covers: `Each user · github__*`. */
export const describeScope = (rule: LimitRule): string => {
  const who =
    rule.subjectMatch === 'each'
      ? SUBJECT_LABEL[rule.subject]
      : `${rule.subject} ${rule.subjectMatch.join(', ')}`;
  const what = [
    rule.scope.tool,
    rule.scope.method,
    rule.scope.installationId && `installation ${rule.scope.installationId}`,
    rule.scope.catalogEntryId && `entry ${rule.scope.catalogEntryId}`,
  ].filter(Boolean);
  return [who, ...what].join(' · ');
};

export type LimitFormValues = {
  name: string;
  kind: LimitRule['kind'];
  subject: LimitRule['subject'];
  /** Empty means "each"; otherwise comma separated ids. */
  subjectIds: string;
  metric: LimitRule['metric'];
  action: LimitRule['action'];
  enabled: boolean;
  ownerTeamId: string;
  tool: string;
  method: string;
  installationId: string;
  catalogEntryId: string;
  points: number;
  perSeconds: number;
  burst: number;
  period: (typeof LIMIT_PERIODS)[number];
  max: number;
  leaseSeconds: number;
};

export const emptyLimitForm = (): LimitFormValues => ({
  name: '',
  kind: 'quota',
  subject: 'user',
  subjectIds: '',
  metric: 'calls',
  action: 'reject',
  enabled: true,
  ownerTeamId: '',
  tool: '',
  method: '',
  installationId: '',
  catalogEntryId: '',
  points: 1000,
  perSeconds: 60,
  burst: 0,
  period: 'day',
  max: 8,
  leaseSeconds: 900,
});

const periodOf = (v: unknown): LimitFormValues['period'] =>
  LIMIT_PERIODS.find((p) => p === v) ?? 'day';

export const limitToForm = (rule: LimitRule): LimitFormValues => ({
  ...emptyLimitForm(),
  name: rule.name,
  kind: rule.kind,
  subject: rule.subject,
  subjectIds: rule.subjectMatch === 'each' ? '' : rule.subjectMatch.join(', '),
  metric: rule.metric,
  action: rule.action,
  enabled: rule.enabled,
  ownerTeamId: rule.ownerTeamId ?? '',
  tool: rule.scope.tool ?? '',
  method: rule.scope.method ?? '',
  installationId: rule.scope.installationId ?? '',
  catalogEntryId: rule.scope.catalogEntryId ?? '',
  points: num(rule.params.points) || 1000,
  perSeconds: num(rule.params.perSeconds) || 60,
  burst: num(rule.params.burst),
  period: periodOf(rule.params.period),
  max: num(rule.params.max) || 8,
  leaseSeconds: num(rule.params.leaseSeconds) || 900,
});

const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Fields shared by the create and patch bodies of a limit rule. */
const commonFields = (v: LimitFormValues) => ({
  name: v.name.trim(),
  subject: v.subject,
  subjectMatch: list(v.subjectIds).length > 0 ? list(v.subjectIds) : ('each' as const),
  scope: {
    ...(v.installationId.trim() ? { installationId: v.installationId.trim() } : {}),
    ...(v.catalogEntryId.trim() ? { catalogEntryId: v.catalogEntryId.trim() } : {}),
    ...(v.tool.trim() ? { tool: v.tool.trim() } : {}),
    ...(v.method.trim() ? { method: v.method.trim() } : {}),
  },
  metric: v.metric,
  action: v.action,
  enabled: v.enabled,
});

const paramsOf = (v: LimitFormValues) =>
  v.kind === 'rate'
    ? { points: v.points, perSeconds: v.perSeconds, burst: v.burst }
    : v.kind === 'quota'
      ? { points: v.points, period: v.period }
      : { max: v.max, leaseSeconds: v.leaseSeconds };

/** `POST /limit-rules`: a union by `kind`. */
export const limitCreateBody = (v: LimitFormValues): Body<'post', '/limit-rules'> => {
  const common = {
    ...commonFields(v),
    ...(v.ownerTeamId ? { ownerTeamId: v.ownerTeamId } : {}),
  };
  if (v.kind === 'rate')
    return {
      ...common,
      kind: 'rate',
      params: { points: v.points, perSeconds: v.perSeconds, burst: v.burst },
    };
  if (v.kind === 'quota')
    return { ...common, kind: 'quota', params: { points: v.points, period: v.period } };
  return { ...common, kind: 'concurrency', params: { max: v.max, leaseSeconds: v.leaseSeconds } };
};

/** `PATCH /limit-rules/{id}`: the kind cannot change; every other field is sent. */
export const limitPatchBody = (v: LimitFormValues): Body<'patch', '/limit-rules/{id}'> => ({
  ...commonFields(v),
  params: paramsOf(v),
  ownerTeamId: v.ownerTeamId || null,
});

// --- identity providers (9.4) --------------------------------------------------------------------------------------

export const discoveryUrlFor = (issuer: string): string =>
  `${issuer.trim().replace(/\/+$/, '')}/.well-known/openid-configuration`;

export type IdpFormValues = {
  name: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space separated. */
  scopes: string;
  claimEmail: string;
  claimName: string;
  claimGroups: string;
  claimSub: string;
  /** Comma separated. */
  emailDomains: string;
  apiScope: string;
  storeRefreshToken: boolean;
  enterpriseManagedAuth: boolean;
  enabled: boolean;
};

export const emptyIdpForm = (): IdpFormValues => ({
  name: '',
  issuer: '',
  discoveryUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  claimEmail: '',
  claimName: '',
  claimGroups: '',
  claimSub: '',
  emailDomains: '',
  apiScope: '',
  storeRefreshToken: false,
  enterpriseManagedAuth: false,
  enabled: true,
});

export const idpToForm = (c: IdpConnection): IdpFormValues => ({
  name: c.name,
  issuer: c.issuer,
  discoveryUrl: c.discoveryUrl,
  clientId: c.clientId,
  clientSecret: '',
  scopes: c.scopes.join(' '),
  claimEmail: c.claimMap.email ?? '',
  claimName: c.claimMap.name ?? '',
  claimGroups: c.claimMap.groups ?? '',
  claimSub: c.claimMap.sub ?? '',
  emailDomains: c.emailDomains.join(', '),
  apiScope: c.apiScope ?? '',
  storeRefreshToken: c.storeRefreshToken,
  enterpriseManagedAuth: c.enterpriseManagedAuth,
  enabled: c.enabled,
});

const idpFields = (v: IdpFormValues) => ({
  name: v.name.trim(),
  issuer: v.issuer.trim(),
  discoveryUrl: v.discoveryUrl.trim(),
  clientId: v.clientId.trim(),
  scopes: v.scopes.split(/\s+/).filter(Boolean),
  claimMap: {
    ...(v.claimEmail.trim() ? { email: v.claimEmail.trim() } : {}),
    ...(v.claimName.trim() ? { name: v.claimName.trim() } : {}),
    ...(v.claimGroups.trim() ? { groups: v.claimGroups.trim() } : {}),
    ...(v.claimSub.trim() ? { sub: v.claimSub.trim() } : {}),
  },
  emailDomains: list(v.emailDomains),
  storeRefreshToken: v.storeRefreshToken,
  apiScope: v.apiScope.trim() || null,
  enterpriseManagedAuth: v.enterpriseManagedAuth,
  enabled: v.enabled,
});

/** The address the IdP sends people back to after sign-in, which the IdP's own application registration must list (9.1). */
export const idpRedirectUri = (baseUrl: string, connectionId: string): string =>
  `${baseUrl.replace(/\/$/, '')}/auth/callback/${connectionId}`;

/** `POST /idp-connections`: the client secret is required and write-only. */
export const idpCreateBody = (v: IdpFormValues): Body<'post', '/idp-connections'> => ({
  ...idpFields(v),
  clientSecret: v.clientSecret,
});

/** `PATCH /idp-connections/{id}`: the secret is sent only when the admin typed a new one. */
export const idpPatchBody = (v: IdpFormValues): Body<'patch', '/idp-connections/{id}'> => ({
  ...idpFields(v),
  ...(v.clientSecret ? { clientSecret: v.clientSecret } : {}),
});

/** The steps of a connection test, as one list the screen renders. */
export const idpTestSteps = (r: IdpTestResult): { name: string; ok: boolean; detail: string }[] => [
  {
    name: 'Discovery document',
    ok: r.ok,
    detail: r.error ?? r.endpoints?.authorization ?? (r.ok ? 'Reachable' : 'Not reachable'),
  },
  ...(r.issuer === undefined
    ? []
    : [
        {
          name: 'Issuer',
          ok: r.issuerMatches === true,
          detail:
            r.issuerMatches === true
              ? r.issuer
              : `The IdP reports ${r.issuer}. Set the Issuer of this connection to exactly that`,
        },
      ]),
  ...(r.endpoints?.token ? [{ name: 'Token endpoint', ok: true, detail: r.endpoints.token }] : []),
  ...(r.endpoints?.jwks ? [{ name: 'JWKS', ok: true, detail: r.endpoints.jwks }] : []),
];

// --- model guards (13.5) -------------------------------------------------------------------------------------------

export const GUARD_KEYS = ['jev', 'llmJudge', 'classifier'] as const;
export type GuardKey = (typeof GUARD_KEYS)[number];

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-1.13.0';

export type ModelGuardValues = {
  enabled: boolean;
  /** `endpoint` (jev, llmJudge) or `url` (classifier). */
  endpoint: string;
  model: string;
  /** Name of the org secret holding the credential (sent as `secret:NAME`). */
  secret: string;
  timeoutMs: number;
  /** Classifier: comma separated labels that mean malicious. */
  maliciousLabels: string;
  threshold: number;
  /** Classifier: header carrying the credential. */
  authHeader: string;
  /** Jev thresholds. */
  warn: number;
  quarantine: number;
  block: number;
};

export type ModelGuardsValues = Record<GuardKey, ModelGuardValues>;

const secretName = (ref: string | undefined): string => ref?.replace(/^secret:/, '') ?? '';

const baseValues = (key: GuardKey): ModelGuardValues => ({
  enabled: false,
  endpoint: key === 'jev' ? JEV_DEFAULT_ENDPOINT : '',
  model: key === 'jev' ? JEV_DEFAULT_MODEL : '',
  secret: key === 'jev' ? 'TYPESAFE_API_KEY' : '',
  timeoutMs: key === 'jev' ? 1500 : key === 'llmJudge' ? 3000 : 500,
  maliciousLabels: '',
  threshold: 0.5,
  authHeader: 'Authorization',
  warn: 0.4,
  quarantine: 0.6,
  block: 0.85,
});

export const modelGuardsToForm = (cfg: ModelGuards): ModelGuardsValues => {
  const out = {} as ModelGuardsValues;
  for (const key of GUARD_KEYS) {
    const c = cfg[key];
    const base = baseValues(key);
    out[key] = c
      ? {
          ...base,
          enabled: true,
          endpoint: c.endpoint ?? c.url ?? base.endpoint,
          model: c.model ?? base.model,
          secret: secretName(c.apiKeySecret ?? c.auth?.secret) || base.secret,
          timeoutMs: c.timeoutMs ?? base.timeoutMs,
          maliciousLabels: (c.maliciousLabels ?? []).join(', '),
          threshold: c.threshold ?? base.threshold,
          authHeader: c.auth?.header ?? base.authHeader,
          warn: c.thresholds?.warn ?? base.warn,
          quarantine: c.thresholds?.quarantine ?? base.quarantine,
          block: c.thresholds?.block ?? base.block,
        }
      : base;
  }
  return out;
};

/** `PUT /settings/model-guards`: a guard that is off is `null`; secrets are sent as references (`secret:NAME`). */
export const modelGuardsBody = (v: ModelGuardsValues): Body<'put', '/settings/model-guards'> => ({
  jev: v.jev.enabled
    ? {
        endpoint: v.jev.endpoint.trim(),
        model: v.jev.model.trim(),
        apiKeySecret: `secret:${v.jev.secret.trim()}`,
        thresholds: { block: v.jev.block, quarantine: v.jev.quarantine, warn: v.jev.warn },
        timeoutMs: v.jev.timeoutMs,
      }
    : null,
  llmJudge: v.llmJudge.enabled
    ? {
        endpoint: v.llmJudge.endpoint.trim(),
        model: v.llmJudge.model.trim(),
        ...(v.llmJudge.secret.trim() ? { apiKeySecret: `secret:${v.llmJudge.secret.trim()}` } : {}),
        timeoutMs: v.llmJudge.timeoutMs,
      }
    : null,
  classifier: v.classifier.enabled
    ? {
        url: v.classifier.endpoint.trim(),
        maliciousLabels: list(v.classifier.maliciousLabels),
        threshold: v.classifier.threshold,
        timeoutMs: v.classifier.timeoutMs,
        ...(v.classifier.secret.trim()
          ? {
              auth: {
                header: v.classifier.authHeader.trim() || 'Authorization',
                secret: `secret:${v.classifier.secret.trim()}`,
              },
            }
          : {}),
      }
    : null,
});

// --- system status (15.7) ------------------------------------------------------------------------------------------

/** The job queues of the status page, deepest first. */
export const queueRows = (
  queues: SystemStatus['queues'],
): { name: string; depth: number; oldestAgeSeconds: number | undefined }[] =>
  Object.entries(queues)
    .map(([name, q]) => ({ name, depth: q.depth, oldestAgeSeconds: q.oldestAgeSeconds }))
    .sort((a, b) => b.depth - a.depth || a.name.localeCompare(b.name));

/**
 * Replica ids that run the newest version while others still run an older one: a rollout in progress. When every
 * replica reports the same version nothing is rolling out.
 */
export const rollingOutReplicas = (replicas: SystemStatus['replicas']): Set<string> => {
  const versions = [...new Set(replicas.map((r) => r.version))].sort(compareVersions);
  const newest = versions.at(-1);
  if (versions.length < 2) return new Set();
  return new Set(replicas.filter((r) => r.version === newest).map((r) => r.id));
};

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};
