/**
 * MSW mock of the settings and system routes, typed by the generated OpenAPI types (see `../http.ts`).
 * `buildSettingsData` seeds the rows in the exact API shape (`Schemas['IdpConnection']`, `Schemas['LimitRule']`,
 * ...), `settingsHandlers` answer the routes from `getDb().data.settings`.
 */
import { ORG_SETTING_DEFAULTS, orgSettingsSchema } from '@bastion-mcp/core/org-settings';
import type { HttpHandler } from 'msw';
import type { Res, Schemas } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  route,
  type SampleFactory,
} from '../http';
import { INTERNAL_REGISTRY_NAME, ORG_NAME, SEED_IDS, TOOL_WARN_THRESHOLD } from '../seed';
import { getDb, nextId } from '../state';
import { DAY, HOUR, iso, nowIso, validationFailed } from '../util';

type OrgSettings = Res<'get', '/settings'>['settings'];

export type SettingsData = {
  settings: OrgSettings;
  /** Version of the settings document: its ETag and `updatedAt`. */
  settingsUpdatedAt: string;
  idpConnections: Schemas['IdpConnection'][];
  modelGuards: Schemas['ModelGuards'];
  limitRules: Schemas['LimitRule'][];
  system: Res<'get', '/system/status'>;
};

/** The seeded per-user limits, which the quotas of `GET /me/quotas` report (`session.ts`). */
export const SEEDED_LIMITS = { callsPerDay: 5000, concurrentCalls: 8 } as const;

export const buildSettingsData = (now: number): SettingsData => ({
  settings: {
    ...ORG_SETTING_DEFAULTS,
    org: { displayName: ORG_NAME, timeZone: 'America/New_York' },
    endpoints: { toolWarnThreshold: TOOL_WARN_THRESHOLD },
    logs: { ...ORG_SETTING_DEFAULTS.logs, capturePreviews: true },
  },
  settingsUpdatedAt: iso(now - 9 * DAY),
  idpConnections: [
    {
      id: 'idp-1',
      name: 'Okta',
      issuer: 'https://acme.okta.com',
      discoveryUrl: 'https://acme.okta.com/.well-known/openid-configuration',
      clientId: '0oa1b2c3d4',
      clientSecretId: 'secret-idp-1',
      scopes: ['openid', 'email', 'profile', 'offline_access'],
      claimMap: { groups: 'groups' },
      emailDomains: ['acme.dev'],
      storeRefreshToken: false,
      apiScope: null,
      enterpriseManagedAuth: false,
      redirectToRoot: false,
      enabled: true,
      createdAt: iso(now - 90 * DAY),
      updatedAt: iso(now - 2 * DAY),
    },
  ],
  modelGuards: {
    jev: null,
    llmJudge: {
      endpoint: 'https://llm.acme.internal/v1/chat/completions',
      model: 'judge-small',
      apiKeySecret: 'secret:LLM_JUDGE_KEY',
      timeoutMs: 3000,
    },
    classifier: null,
    updatedAt: iso(now - 20 * DAY),
  },
  limitRules: [
    {
      id: 'lr-1',
      name: 'Tool calls per user',
      ownerTeamId: null,
      subject: 'user',
      subjectMatch: 'each',
      scope: {},
      kind: 'quota',
      params: { points: SEEDED_LIMITS.callsPerDay, period: 'day' },
      metric: 'calls',
      cost: null,
      action: 'reject',
      enabled: true,
      createdAt: iso(now - 60 * DAY),
      updatedAt: iso(now - 30 * DAY),
    },
    {
      id: 'lr-2',
      name: 'Burst rate',
      ownerTeamId: null,
      subject: 'user',
      subjectMatch: 'each',
      scope: {},
      kind: 'rate',
      params: { points: 60, perSeconds: 60, burst: 10 },
      metric: 'calls',
      cost: null,
      action: 'reject',
      enabled: true,
      createdAt: iso(now - 60 * DAY),
      updatedAt: iso(now - 30 * DAY),
    },
    {
      id: 'lr-3',
      name: 'Concurrent calls',
      ownerTeamId: null,
      subject: 'user',
      subjectMatch: 'each',
      scope: {},
      kind: 'concurrency',
      params: { max: SEEDED_LIMITS.concurrentCalls, leaseSeconds: 900 },
      metric: 'calls',
      cost: null,
      action: 'reject',
      enabled: true,
      createdAt: iso(now - 60 * DAY),
      updatedAt: iso(now - 30 * DAY),
    },
  ],
  system: {
    replicas: [
      ...[1, 2, 3, 4, 5].map((n) => ({
        id: `worker-${n}`,
        role: 'worker',
        startedAt: iso(now - (n === 5 ? 14 * HOUR : (7 - n) * DAY)),
        version: '1.4.0',
      })),
      { id: 'worker-6', role: 'worker', startedAt: iso(now - 18 * 60_000), version: '1.4.1' },
      { id: 'ui-1', role: 'ui', startedAt: iso(now - 6 * DAY), version: '1.4.0' },
      { id: 'ui-2', role: 'ui', startedAt: iso(now - 6 * DAY), version: '1.4.0' },
    ],
    leases: {
      active: 14,
      byInstallation: {
        [SEED_IDS.installation.github]: 6,
        [SEED_IDS.installation.postgres]: 4,
        [SEED_IDS.installation.jira]: 4,
      },
    },
    queues: {
      'upstream-reconnect': { depth: 8, oldestAgeSeconds: 12 },
      'sandbox-start': { depth: 34, oldestAgeSeconds: 3 },
      'guard-model-calls': { depth: 62, oldestAgeSeconds: 41 },
      'audit-export': { depth: 4 },
    },
    driver: { name: 'kubernetes', healthy: true, detail: 'gVisor runtime class' },
    registrySync: [
      {
        sourceId: 'rs-official',
        name: 'Official MCP Registry',
        lastSyncAt: iso(now - 40 * 60_000),
        ok: true,
      },
      {
        sourceId: 'rs-acme',
        name: INTERNAL_REGISTRY_NAME,
        lastSyncAt: iso(now - 6 * HOUR),
        ok: false,
        error: 'timeout fetching /v0/servers',
      },
    ],
    kms: {
      provider: 'Cloud KMS',
      healthy: true,
      kekRef: 'projects/acme/locations/global/keyRings/bastion/cryptoKeys/kek/versions/3',
      lastRotatedAt: iso(now - 12 * DAY),
    },
    configVersion: 'cfg-2041',
  },
});

const data = () => getDb().data.settings;
const newId = nextId;
const stamp = nowIso;

const requireFields = (body: object, names: string[]) =>
  names
    .filter((n) => {
      const v = (body as Record<string, unknown>)[n];
      return v === undefined || v === null || v === '';
    })
    .map((n) => ({ path: `/${n}`, message: 'Required' }));

const limitParamErrors = (kind: string, params: Record<string, unknown>) => {
  const positive = (k: string) =>
    typeof params[k] === 'number' && Number.isInteger(params[k]) && (params[k] as number) > 0
      ? []
      : [{ path: `/params/${k}`, message: 'Must be a positive integer' }];
  if (kind === 'rate') return [...positive('points'), ...positive('perSeconds')];
  if (kind === 'quota') return positive('points');
  return positive('max');
};

export const settingsHandlers: HttpHandler[] = [
  // --- org settings --------------------------------------------------------------------------------------------
  route.get(
    '/settings',
    () => {
      const d = data();
      return HttpResponse.json(
        { settings: d.settings, updatedAt: d.settingsUpdatedAt },
        { headers: etagHeaders(d.settingsUpdatedAt) },
      );
    },
    { allow: 'readConfig' },
  ),
  route.patch(
    '/settings',
    async ({ request, body }) => {
      const d = data();
      const stale = checkVersion(request, { updatedAt: d.settingsUpdatedAt });
      if (stale) return stale;
      const patch = await body();
      const errors: { path: string; message: string }[] = [];
      const next = { ...d.settings } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        const shape = (
          orgSettingsSchema.shape as Record<
            string,
            {
              safeParse: (v: unknown) => {
                success: boolean;
                error?: { issues: { message: string }[] };
              };
            }
          >
        )[key];
        const parsed = shape?.safeParse(value);
        if (!parsed?.success) {
          errors.push({
            path: `/${key}`,
            message: parsed?.error?.issues[0]?.message ?? 'Unknown setting',
          });
        } else next[key] = value;
      }
      if (errors.length > 0) return validationFailed(errors);
      d.settings = next as OrgSettings;
      d.settingsUpdatedAt = stamp();
      return HttpResponse.json(
        { settings: d.settings, updatedAt: d.settingsUpdatedAt },
        { headers: etagHeaders(d.settingsUpdatedAt) },
      );
    },
    { allow: 'admin' },
  ),

  // --- identity providers --------------------------------------------------------------------------------------
  route.get(
    '/idp-connections',
    ({ url }) => {
      return HttpResponse.json(pageOf(data().idpConnections, url));
    },
    { allow: 'admin' },
  ),
  route.post(
    '/idp-connections',
    async ({ body }) => {
      const b = await body();
      const errors = [
        ...requireFields(b, ['name', 'issuer', 'discoveryUrl', 'clientId', 'clientSecret']),
        ...(b.scopes?.length ? [] : [{ path: '/scopes', message: 'Give at least one scope' }]),
      ];
      if (errors.length > 0) return validationFailed(errors);
      const now = stamp();
      const row: Schemas['IdpConnection'] = {
        id: newId('idp'),
        name: b.name,
        issuer: b.issuer,
        discoveryUrl: b.discoveryUrl,
        clientId: b.clientId,
        clientSecretId: newId('secret'),
        scopes: b.scopes ?? ['openid', 'email', 'profile'],
        claimMap: b.claimMap ?? {},
        emailDomains: b.emailDomains ?? [],
        storeRefreshToken: b.storeRefreshToken ?? false,
        apiScope: b.apiScope ?? null,
        enterpriseManagedAuth: b.enterpriseManagedAuth ?? false,
        redirectToRoot: b.redirectToRoot ?? false,
        enabled: b.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      data().idpConnections.push(row);
      return HttpResponse.json(row, { status: 201, headers: etagHeaders(now) });
    },
    { allow: 'admin' },
  ),
  route.get(
    '/idp-connections/{id}',
    ({ params }) => {
      const row = data().idpConnections.find((x) => x.id === params.id);
      return row
        ? HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) })
        : notFound('Connection');
    },
    { allow: 'admin' },
  ),
  route.patch(
    '/idp-connections/{id}',
    async ({ request, params, body }) => {
      const row = data().idpConnections.find((x) => x.id === params.id);
      if (!row) return notFound('Connection');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      const { clientSecret: _secret, ...patch } = await body();
      Object.assign(row, patch, { updatedAt: stamp() });
      return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
    },
    { allow: 'admin' },
  ),
  route.delete(
    '/idp-connections/{id}',
    ({ request, params }) => {
      const d = data();
      const row = d.idpConnections.find((x) => x.id === params.id);
      if (!row) return notFound('Connection');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      d.idpConnections = d.idpConnections.filter((x) => x.id !== params.id);
      return noContent();
    },
    { allow: 'admin' },
  ),
  route.post(
    '/idp-connections/{id}/test',
    ({ params }) => {
      const row = data().idpConnections.find((x) => x.id === params.id);
      if (!row) return notFound('Connection');
      const ok = row.issuer.startsWith('https://');
      return HttpResponse.json(
        ok
          ? {
              ok,
              issuer: row.issuer,
              issuerMatches: true,
              endpoints: {
                authorization: `${row.issuer}/oauth2/v1/authorize`,
                token: `${row.issuer}/oauth2/v1/token`,
                jwks: `${row.issuer}/oauth2/v1/keys`,
              },
            }
          : { ok, error: 'The issuer must use https' },
      );
    },
    { allow: 'admin' },
  ),

  // --- model guards --------------------------------------------------------------------------------------------
  route.get(
    '/settings/model-guards',
    () => {
      const guards = data().modelGuards;
      return HttpResponse.json(guards, {
        headers: guards.updatedAt ? etagHeaders(guards.updatedAt) : {},
      });
    },
    { allow: 'readConfig' },
  ),
  route.put(
    '/settings/model-guards',
    async ({ request, body, waiveVersion }) => {
      const current = data().modelGuards.updatedAt;
      // The first save creates the document: there is no version to name yet (17.1).
      if (!current) waiveVersion();
      const stale = current ? checkVersion(request, { updatedAt: current }) : null;
      if (stale) return stale;
      const b = await body();
      const literal = Object.entries(b).flatMap(([guard, cfg]) =>
        cfg && typeof cfg.apiKeySecret === 'string' && !cfg.apiKeySecret.startsWith('secret:')
          ? [
              {
                path: `/${guard}/apiKeySecret`,
                message: 'Reference the secret by name (secret:NAME)',
              },
            ]
          : [],
      );
      if (literal.length > 0) return validationFailed(literal);
      const next = {
        jev: b.jev,
        llmJudge: b.llmJudge,
        classifier: b.classifier,
        updatedAt: stamp(),
      };
      data().modelGuards = next as Schemas['ModelGuards'];
      return HttpResponse.json(data().modelGuards, { headers: etagHeaders(next.updatedAt) });
    },
    { allow: 'admin' },
  ),

  // --- limit rules ---------------------------------------------------------------------------------------------
  route.get('/limit-rules', ({ url }) => HttpResponse.json(pageOf(data().limitRules, url))),
  route.post(
    '/limit-rules',
    async ({ body }) => {
      const b = await body();
      const errors = [
        ...requireFields(b, ['name', 'subject', 'kind']),
        ...limitParamErrors(b.kind, b.params),
      ];
      if (errors.length > 0) return validationFailed(errors);
      const now = stamp();
      const row: Schemas['LimitRule'] = {
        id: newId('lr'),
        name: b.name,
        ownerTeamId: b.ownerTeamId ?? null,
        subject: b.subject,
        subjectMatch: b.subjectMatch ?? 'each',
        scope: b.scope ?? {},
        kind: b.kind,
        params: b.params,
        metric: b.metric ?? 'calls',
        cost: b.cost ?? null,
        action: b.action ?? 'reject',
        enabled: b.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      data().limitRules.push(row);
      return HttpResponse.json(row, { status: 201, headers: etagHeaders(now) });
    },
    { allow: 'admin' },
  ),
  route.patch(
    '/limit-rules/{id}',
    async ({ request, params, body }) => {
      const row = data().limitRules.find((x) => x.id === params.id);
      if (!row) return notFound('Rule');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      const b = await body();
      const merged = { ...row, ...b };
      const errors = limitParamErrors(row.kind, merged.params);
      if (errors.length > 0) return validationFailed(errors);
      Object.assign(row, b, { updatedAt: stamp() });
      return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
    },
    { allow: 'admin' },
  ),
  route.delete(
    '/limit-rules/{id}',
    ({ request, params }) => {
      const d = data();
      const row = d.limitRules.find((x) => x.id === params.id);
      if (!row) return notFound('Rule');
      const stale = checkVersion(request, row);
      if (stale) return stale;
      d.limitRules = d.limitRules.filter((x) => x.id !== params.id);
      return noContent();
    },
    { allow: 'admin' },
  ),

  // --- system ----------------------------------------------------------------------------------------------------
  route.get(
    '/system/status',
    () => {
      return HttpResponse.json(data().system);
    },
    { allow: 'readConfig' },
  ),
  route.post(
    '/system/kms/rotate',
    () => {
      const kms = data().system.kms;
      const version = Number(kms.kekRef?.match(/versions\/(\d+)$/)?.[1] ?? 0) + 1;
      kms.kekRef = `${kms.kekRef?.replace(/versions\/\d+$/, '') ?? 'kek/'}versions/${version}`;
      kms.lastRotatedAt = stamp();
      return HttpResponse.json({ kekRef: kms.kekRef, rewrapped: 128 });
    },
    { allow: 'admin' },
  ),
];

/** One valid call per operation of this domain (checked against the OpenAPI document by route-contract.test.ts). */
export const settingsSamples: SampleFactory = () => [
  { method: 'get', path: '/settings' },
  { method: 'patch', path: '/settings', body: { personalInstalls: 'all' } },
  { method: 'get', path: '/idp-connections' },
  { method: 'get', path: '/idp-connections/idp-1' },
  {
    method: 'post',
    path: '/idp-connections',
    body: {
      name: 'Entra',
      issuer: 'https://login.microsoftonline.com/acme/v2.0',
      discoveryUrl: 'https://login.microsoftonline.com/acme/v2.0/.well-known/openid-configuration',
      clientId: 'abc',
      clientSecret: 's3cret',
      scopes: ['openid', 'email'],
      claimMap: { groups: 'groups' },
      emailDomains: ['acme.dev'],
      storeRefreshToken: false,
      apiScope: null,
      enterpriseManagedAuth: false,
      redirectToRoot: false,
      enabled: true,
    },
  },
  { method: 'patch', path: '/idp-connections/idp-1', body: { name: 'Okta (prod)' } },
  { method: 'post', path: '/idp-connections/idp-1/test' },
  { method: 'delete', path: '/idp-connections/idp-1' },
  { method: 'get', path: '/settings/model-guards' },
  {
    method: 'put',
    path: '/settings/model-guards',
    body: {
      jev: null,
      llmJudge: {
        endpoint: 'https://llm.acme.internal/v1/chat/completions',
        model: 'judge-small',
        apiKeySecret: 'secret:LLM_JUDGE_KEY',
        timeoutMs: 3000,
      },
      classifier: {
        url: 'https://clf.acme.internal/predict',
        maliciousLabels: ['MALICIOUS'],
        threshold: 0.5,
        timeoutMs: 500,
      },
    },
  },
  { method: 'get', path: '/limit-rules' },
  {
    method: 'post',
    path: '/limit-rules',
    body: {
      name: 'Hourly writes',
      kind: 'rate',
      subject: 'user',
      subjectMatch: 'each',
      scope: { tool: 'github__*' },
      metric: 'calls',
      action: 'warn',
      enabled: true,
      params: { points: 100, perSeconds: 3600, burst: 0 },
    },
  },
  { method: 'patch', path: '/limit-rules/lr-1', body: { params: { points: 6000, period: 'day' } } },
  { method: 'delete', path: '/limit-rules/lr-3' },
  { method: 'get', path: '/system/status' },
  { method: 'post', path: '/system/kms/rotate' },
];
