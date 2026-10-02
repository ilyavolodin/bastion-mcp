import { describe, expect, it } from 'vitest';
import {
  BASTION_META_PREFIX,
  DEFAULT_LIMIT_RULES,
  ERROR_CODES,
  metaKey,
  PROTOCOL_VERSIONS,
  REDIS_CHANNELS,
  redisKeys,
} from '../src/constants';
import { ORG_SETTING_DEFAULTS, orgSettingsSchema, resolveOrgSettings } from '../src/org-settings';

describe('shared constants', () => {
  it('6.9 error codes are unique and inside -32000..-32019', () => {
    const codes = Object.values(ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toBeLessThanOrEqual(-32000);
    for (const c of codes) expect(c).toBeGreaterThanOrEqual(-32019);
  });

  it('6.1 protocol versions split by era', () => {
    expect(PROTOCOL_VERSIONS.modern).toEqual(['2026-07-28']);
    expect(PROTOCOL_VERSIONS.legacy).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
    expect(PROTOCOL_VERSIONS.default).toBe('2025-03-26');
  });

  it('6.9 bastion _meta keys use the io.github.bastion-mcp/ prefix', () => {
    expect(BASTION_META_PREFIX).toBe('io.github.bastion-mcp/');
    expect(metaKey('error')).toBe('io.github.bastion-mcp/error');
  });

  it('16.3 redis key builders follow the documented shapes', () => {
    expect(redisKeys.session('s1')).toBe('sess:s1');
    expect(redisKeys.lease('i1')).toBe('lease:i1');
    expect(redisKeys.era('inst', 'cred')).toBe('era:inst:cred');
    expect(redisKeys.listCache('inst', 'cred', 'tools/list')).toBe('lc:inst:cred:tools/list');
    expect(redisKeys.revoked('p1')).toBe('revoked:p1');
    expect(redisKeys.risk('p1', 'c1')).toBe('risk:p1:c1');
    expect(redisKeys.quota('r1', 's1', '2026-10')).toBe('q:r1:s1:2026-10');
    expect(redisKeys.rate('r1', 's1')).toBe('rl:r1:s1');
    expect(redisKeys.guardCache('g', 'h', 'sha')).toBe('guard:g:h:sha');
    expect(REDIS_CHANNELS.config).toBe('bastion:config');
    expect(REDIS_CHANNELS.notify).toBe('bastion:notify');
    expect(REDIS_CHANNELS.session('s1')).toBe('bastion:sess:s1');
  });

  it('16.3 every redis key builder returns a non-empty string', () => {
    for (const build of Object.values(redisKeys)) {
      const key = (build as (...args: string[]) => string)('a', 'b', 'c');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('14.3 default limits', () => {
    expect(DEFAULT_LIMIT_RULES.userCalls).toEqual({ points: 600, perSeconds: 60, burst: 100 });
    expect(DEFAULT_LIMIT_RULES.userConcurrency).toEqual({ max: 20, leaseSeconds: 900 });
    expect(DEFAULT_LIMIT_RULES.serviceAccountCalls).toEqual({
      points: 3000,
      perSeconds: 60,
      burst: 500,
    });
    expect(DEFAULT_LIMIT_RULES.userSamplingPerDay).toBe(200);
  });

  it('19.2 org setting defaults satisfy their own schema', () => {
    expect(orgSettingsSchema.parse(ORG_SETTING_DEFAULTS)).toEqual(ORG_SETTING_DEFAULTS);
    expect(ORG_SETTING_DEFAULTS.personalInstalls).toBe('remoteOnly');
    expect(ORG_SETTING_DEFAULTS.tokens).toEqual({
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      refreshIdleDays: 7,
      patMaxDays: 90,
    });
  });

  it('19.2 resolveOrgSettings overlays stored keys on the defaults', () => {
    const merged = resolveOrgSettings({ personalInstalls: 'all' });
    expect(merged.personalInstalls).toBe('all');
    expect(merged.tokens).toEqual(ORG_SETTING_DEFAULTS.tokens);
    expect(() => resolveOrgSettings({ personalInstalls: 'nope' })).toThrow();
  });
});
