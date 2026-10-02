/**
 * MSW mock of the settings and system routes, typed by the generated OpenAPI types (see `../http.ts`).
 * `buildSettingsData` seeds the rows in the exact API shape (`Schemas['IdpConnection']`, `Schemas['LimitRule']`,
 * ...), `settingsHandlers` answer the routes from `getDb().data.settings`.
 */
import { ORG_SETTING_DEFAULTS, orgSettingsSchema } from '@bastion-mcp/core/org-settings';
import type { HttpHandler } from 'msw';
import type { Res, Schemas } from '@/api/schema';
import { getDb } from '../db';
import {
  etagHeaders,
  forbidden,
  HttpResponse,
  noContent,
  notFound,
  pageOf,
  problem,
  route,
  type SampleFactory,
} from '../http';

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

export const buildSettingsData = (now: number): SettingsData => ({
  settings: {
    ...ORG_SETTING_DEFAULTS,
    org: { displayName: 'Acme Corp', timeZone: 'America/New_York' },
    endpoints: { toolWarnThreshold: 40 },
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
      params: { points: 5000, period: 'day' },
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
      params: { max: 8, leaseSeconds: 900 },
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
    leases: { active: 14, byInstallation: { 'i-github': 6, 'i-postgres': 4, 'i-jira': 4 } },
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
        name: 'Acme internal registry',
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
const isAdmin = () => getDb().role === 'admin';
let seq = 100;
const newId = (prefix: string) => `${prefix}-${++seq}`;
const stamp = () => new Date().toISOString();

const requireFields = (body: object, names: string[]) =>
  names
    .filter((n) => {
      const v = (body as Record<string, unknown>)[n];
      return v === undefined || v === null || v === '';
    })
    .map((n) => ({ path: `/${n}`, message: 'Required' }));

const invalid = (errors: { path: string; message: string }[]) =>
  problem(422, 'validation_failed', 'Some fields need attention', 'Validation failed', errors);

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
  route.get('/settings', () => {
    if (!['admin', 'manager', 'auditor'].includes(getDb().role)) return forbidden();
    const d = data();
    return HttpResponse.json(
      { settings: d.settings, updatedAt: d.settingsUpdatedAt },
      { headers: etagHeaders(d.settingsUpdatedAt) },
    );
  }),
  route.patch('/settings', async ({ body }) => {
    if (!isAdmin()) return forbidden();
    const patch = await body();
    const d = data();
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
      if (!parsed || !parsed.success) {
        errors.push({
          path: `/${key}`,
          message: parsed?.error?.issues[0]?.message ?? 'Unknown setting',
        });
      } else next[key] = value;
    }
    if (errors.length > 0) return invalid(errors);
    d.settings = next as OrgSettings;
    d.settingsUpdatedAt = stamp();
    return HttpResponse.json(
      { settings: d.settings, updatedAt: d.settingsUpdatedAt },
      { headers: etagHeaders(d.settingsUpdatedAt) },
    );
  }),

  // --- identity providers --------------------------------------------------------------------------------------
  route.get('/idp-connections', ({ url }) => {
    if (!isAdmin()) return forbidden();
    return HttpResponse.json(pageOf(data().idpConnections, url));
  }),
  route.post('/idp-connections', async ({ body }) => {
    if (!isAdmin()) return forbidden();
    const b = await body();
    const errors = [
      ...requireFields(b, ['name', 'issuer', 'discoveryUrl', 'clientId', 'clientSecret']),
      ...(b.scopes?.length ? [] : [{ path: '/scopes', message: 'Give at least one scope' }]),
    ];
    if (errors.length > 0) return invalid(errors);
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
      enabled: b.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    data().idpConnections.push(row);
    return HttpResponse.json(row, { status: 201, headers: etagHeaders(now) });
  }),
  route.get('/idp-connections/{id}', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const row = data().idpConnections.find((x) => x.id === params.id);
    return row
      ? HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) })
      : notFound('Connection');
  }),
  route.patch('/idp-connections/{id}', async ({ params, body }) => {
    if (!isAdmin()) return forbidden();
    const row = data().idpConnections.find((x) => x.id === params.id);
    if (!row) return notFound('Connection');
    const { clientSecret: _secret, ...patch } = await body();
    Object.assign(row, patch, { updatedAt: stamp() });
    return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
  }),
  route.delete('/idp-connections/{id}', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const d = data();
    if (!d.idpConnections.some((x) => x.id === params.id)) return notFound('Connection');
    d.idpConnections = d.idpConnections.filter((x) => x.id !== params.id);
    return noContent();
  }),
  route.post('/idp-connections/{id}/test', ({ params }) => {
    if (!isAdmin()) return forbidden();
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
  }),

  // --- model guards --------------------------------------------------------------------------------------------
  route.get('/settings/model-guards', () => {
    if (!['admin', 'manager', 'auditor'].includes(getDb().role)) return forbidden();
    const guards = data().modelGuards;
    return HttpResponse.json(guards, {
      headers: guards.updatedAt ? etagHeaders(guards.updatedAt) : {},
    });
  }),
  route.put('/settings/model-guards', async ({ body }) => {
    if (!isAdmin()) return forbidden();
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
    if (literal.length > 0) return invalid(literal);
    const next = { jev: b.jev, llmJudge: b.llmJudge, classifier: b.classifier, updatedAt: stamp() };
    data().modelGuards = next as Schemas['ModelGuards'];
    return HttpResponse.json(data().modelGuards, { headers: etagHeaders(next.updatedAt) });
  }),

  // --- limit rules ---------------------------------------------------------------------------------------------
  route.get('/limit-rules', ({ url }) => HttpResponse.json(pageOf(data().limitRules, url))),
  route.post('/limit-rules', async ({ body }) => {
    if (!isAdmin()) return forbidden();
    const b = await body();
    const errors = [
      ...requireFields(b, ['name', 'subject', 'kind']),
      ...limitParamErrors(b.kind, b.params),
    ];
    if (errors.length > 0) return invalid(errors);
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
  }),
  route.patch('/limit-rules/{id}', async ({ params, body }) => {
    if (!isAdmin()) return forbidden();
    const row = data().limitRules.find((x) => x.id === params.id);
    if (!row) return notFound('Rule');
    const b = await body();
    const merged = { ...row, ...b };
    const errors = limitParamErrors(row.kind, merged.params);
    if (errors.length > 0) return invalid(errors);
    Object.assign(row, b, { updatedAt: stamp() });
    return HttpResponse.json(row, { headers: etagHeaders(row.updatedAt) });
  }),
  route.delete('/limit-rules/{id}', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const d = data();
    if (!d.limitRules.some((x) => x.id === params.id)) return notFound('Rule');
    d.limitRules = d.limitRules.filter((x) => x.id !== params.id);
    return noContent();
  }),

  // --- system ----------------------------------------------------------------------------------------------------
  route.get('/system/status', () => {
    if (!['admin', 'manager', 'auditor'].includes(getDb().role)) return forbidden();
    return HttpResponse.json(data().system);
  }),
  route.post('/system/kms/rotate', () => {
    if (!isAdmin()) return forbidden();
    const kms = data().system.kms;
    const version = Number(kms.kekRef?.match(/versions\/(\d+)$/)?.[1] ?? 0) + 1;
    kms.kekRef = `${kms.kekRef?.replace(/versions\/\d+$/, '') ?? 'kek/'}versions/${version}`;
    kms.lastRotatedAt = stamp();
    return HttpResponse.json({ kekRef: kms.kekRef, rewrapped: 128 });
  }),
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
