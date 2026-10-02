import { describe, expect, it } from 'vitest';
import {
  describeLimit,
  describeScope,
  discoveryUrlFor,
  emptyLimitForm,
  idpCreateBody,
  idpPatchBody,
  idpTestSteps,
  idpToForm,
  type LimitRule,
  limitCreateBody,
  limitPatchBody,
  limitToForm,
  modelGuardsBody,
  modelGuardsToForm,
  queueRows,
  rollingOutReplicas,
} from '@/api/views/settings';
import { buildSettingsData } from '@/mocks/domains/settings';

const data = buildSettingsData(Date.UTC(2026, 4, 1));
const rule = (id: string): LimitRule => {
  const r = data.limitRules.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
};

describe('settings views', () => {
  it('14.1 describes the parameters of each kind of limit', () => {
    expect(describeLimit(rule('lr-1'))).toBe('5,000 per day');
    expect(describeLimit(rule('lr-2'))).toBe('60 per minute (burst 10)');
    expect(describeLimit(rule('lr-3'))).toBe('8 at once');
    expect(describeScope(rule('lr-1'))).toBe('Each user');
    expect(
      describeScope({ ...rule('lr-1'), subjectMatch: ['u-1'], scope: { tool: 'gh__*' } }),
    ).toBe('user u-1 · gh__*');
  });

  it('14.1 round-trips a rule through the form and builds the body per kind', () => {
    const form = limitToForm(rule('lr-2'));
    expect(limitCreateBody(form)).toMatchObject({
      kind: 'rate',
      subjectMatch: 'each',
      params: { points: 60, perSeconds: 60, burst: 10 },
    });
    expect(limitPatchBody({ ...form, ownerTeamId: 't-data' })).toMatchObject({
      ownerTeamId: 't-data',
      params: { points: 60, perSeconds: 60, burst: 10 },
    });
    expect(
      limitCreateBody({ ...emptyLimitForm(), name: ' Q ', kind: 'quota', period: 'week' }),
    ).toMatchObject({
      name: 'Q',
      params: { points: 1000, period: 'week' },
    });
    expect(
      limitCreateBody({
        ...emptyLimitForm(),
        name: 'S',
        subjectIds: 'a, b ,',
        kind: 'concurrency',
      }),
    ).toMatchObject({ subjectMatch: ['a', 'b'], params: { max: 8, leaseSeconds: 900 } });
  });

  it('9.4 derives the discovery URL and builds create and patch bodies', () => {
    expect(discoveryUrlFor('https://acme.okta.com//')).toBe(
      'https://acme.okta.com/.well-known/openid-configuration',
    );
    const idp = data.idpConnections[0];
    if (!idp) throw new Error('seed');
    const form = idpToForm(idp);
    expect(form.scopes).toBe('openid email profile offline_access');
    expect(form.clientSecret).toBe('');
    expect('clientSecret' in idpPatchBody(form)).toBe(false);
    expect(idpPatchBody({ ...form, clientSecret: 'new' }).clientSecret).toBe('new');
    expect(idpCreateBody({ ...form, clientSecret: 'x' })).toMatchObject({
      claimMap: { groups: 'groups' },
      emailDomains: ['acme.dev'],
      apiScope: null,
    });
  });

  it('9.4 turns a connection test into steps', () => {
    expect(
      idpTestSteps({
        ok: true,
        issuer: 'https://a',
        issuerMatches: false,
        endpoints: { token: 'https://a/t' },
      }).map((s) => [s.name, s.ok]),
    ).toEqual([
      ['Discovery document', true],
      ['Issuer', false],
      ['Token endpoint', true],
    ]);
    expect(idpTestSteps({ ok: false, error: 'boom' })).toEqual([
      { name: 'Discovery document', ok: false, detail: 'boom' },
    ]);
  });

  it('13.5 maps stored model guards to form values and back, with secret references', () => {
    const form = modelGuardsToForm(data.modelGuards);
    expect(form.jev.enabled).toBe(false);
    expect(form.llmJudge).toMatchObject({
      enabled: true,
      secret: 'LLM_JUDGE_KEY',
      timeoutMs: 3000,
    });
    const body = modelGuardsBody({
      ...form,
      classifier: {
        ...form.classifier,
        enabled: true,
        endpoint: 'https://c',
        maliciousLabels: 'BAD, EVIL',
        secret: 'CLF',
      },
    });
    expect(body.jev).toBeNull();
    expect(body.llmJudge).toMatchObject({ apiKeySecret: 'secret:LLM_JUDGE_KEY' });
    expect(body.classifier).toMatchObject({
      url: 'https://c',
      maliciousLabels: ['BAD', 'EVIL'],
      auth: { header: 'Authorization', secret: 'secret:CLF' },
    });
  });

  it('15.7 sorts queues deepest first and finds replicas in a rollout', () => {
    expect(queueRows(data.system.queues).map((q) => q.name)).toEqual([
      'guard-model-calls',
      'sandbox-start',
      'upstream-reconnect',
      'audit-export',
    ]);
    expect([...rollingOutReplicas(data.system.replicas)]).toEqual(['worker-6']);
    expect(
      rollingOutReplicas(data.system.replicas.map((r) => ({ ...r, version: '1.4.0' }))).size,
    ).toBe(0);
  });
});
