import { describe, expect, it } from 'vitest';
import { ORG_SETTING_DEFAULTS, orgSettingsSchema, resolveOrgSettings } from '../src';

describe('19.2 org settings defaults', () => {
  it('19.2 the defaults satisfy their own schema', () => {
    expect(orgSettingsSchema.parse(ORG_SETTING_DEFAULTS)).toEqual(ORG_SETTING_DEFAULTS);
  });

  it('19.2 ship the documented starting values', () => {
    expect(ORG_SETTING_DEFAULTS.personalInstalls).toBe('remoteOnly');
    expect(ORG_SETTING_DEFAULTS.tokens.accessTtlSeconds).toBe(900);
    expect(ORG_SETTING_DEFAULTS.endpoints.toolWarnThreshold).toBe(40);
    expect(ORG_SETTING_DEFAULTS.logs.capturePreviews).toBe(false);
    expect(ORG_SETTING_DEFAULTS.registry.defaultSourceEnabled).toBe(false);
  });
});

describe('19.2 resolveOrgSettings', () => {
  it('19.2 returns the defaults when nothing is stored', () => {
    expect(resolveOrgSettings({})).toEqual(ORG_SETTING_DEFAULTS);
  });

  it('19.2 a stored top-level key replaces the whole default section', () => {
    const resolved = resolveOrgSettings({
      logs: { retentionDays: 7, capturePreviews: true, managerVisibility: false },
    });
    expect(resolved.logs).toEqual({
      retentionDays: 7,
      capturePreviews: true,
      managerVisibility: false,
    });
    expect(resolved.audit).toEqual(ORG_SETTING_DEFAULTS.audit);
  });

  it('19.2 a partial section is rejected rather than filled in silently', () => {
    expect(() => resolveOrgSettings({ logs: { retentionDays: 7 } })).toThrow();
  });

  it.each([
    ['an unknown personal-install mode', { personalInstalls: 'sometimes' }],
    [
      'a non-positive token lifetime',
      { tokens: { ...ORG_SETTING_DEFAULTS.tokens, accessTtlSeconds: 0 } },
    ],
    [
      'an idle timeout above one day',
      { sandbox: { ...ORG_SETTING_DEFAULTS.sandbox, idleTimeoutMinutes: 1441 } },
    ],
    ['a malformed webhook url', { audit: { retentionDays: 1, webhookUrl: 'not a url' } }],
    ['a non-uuid default profile id', { guards: { orgDefaultProfileId: 'org-default' } }],
    ['an empty display name', { org: { displayName: '', timeZone: 'UTC' } }],
    [
      'a negative warm pool',
      {
        sandbox: { ...ORG_SETTING_DEFAULTS.sandbox, warmPool: { small: -1, medium: 0, large: 0 } },
      },
    ],
  ])('19.2 rejects %s', (_name, stored) => {
    expect(() => resolveOrgSettings(stored)).toThrow();
  });

  it('19.2 accepts a webhook url and a profile uuid', () => {
    const resolved = resolveOrgSettings({
      audit: { retentionDays: 90, webhookUrl: 'https://hooks.example.com/audit' },
      guards: { orgDefaultProfileId: '3f2b8a52-9c1e-4f0a-8d77-0b6f1c2d3e4f' },
    });
    expect(resolved.audit.webhookUrl).toBe('https://hooks.example.com/audit');
    expect(resolved.guards.orgDefaultProfileId).toBe('3f2b8a52-9c1e-4f0a-8d77-0b6f1c2d3e4f');
  });

  it('19.2 does not mutate the defaults when merging', () => {
    const before = structuredClone(ORG_SETTING_DEFAULTS);
    resolveOrgSettings({ endpoints: { toolWarnThreshold: 5 } });
    expect(ORG_SETTING_DEFAULTS).toEqual(before);
  });
});
