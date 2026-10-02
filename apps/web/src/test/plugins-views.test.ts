import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/api/schema';
import {
  canManageMarketplace,
  channelTotals,
  mirrorSummary,
  rolloutText,
  toClientSetup,
  toPluginViews,
  toReleaseViews,
} from '@/api/views/plugins';

const release = (seq: number, promoted = false): Schemas['MarketplaceRelease'] => ({
  seq,
  gitCommit: `c${seq}`,
  releaseTime: `2026-01-0${seq}T00:00:00.000Z`,
  promoted,
  items: [],
});

describe('plugins views (25)', () => {
  it('marks only the newest release as the draft when it is newer than the promoted one', () => {
    const list = toReleaseViews([release(3), release(1), release(2, true)], 2);
    expect(list.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(list.map((r) => r.draft)).toEqual([false, false, true]);
    expect(toReleaseViews([release(1, true)], 1).some((r) => r.draft)).toBe(false);
    expect(toReleaseViews([release(1)], null)[0]?.draft).toBe(true);
  });

  it('joins release items with catalog plugin entries by slug', () => {
    const views = toPluginViews(
      {
        items: [
          { name: 'incident-kit', version: '2.0.0', policy: 'required' },
          { name: 'unknown', version: '0.1.0', policy: 'available' },
        ],
      },
      new Map([
        [
          'incident-kit',
          { id: 'c1', slug: 'incident-kit', displayName: 'Incident kit', description: 'Triage' },
        ],
      ]),
    );
    expect(views[0]).toMatchObject({
      name: 'Incident kit',
      letter: 'I',
      entryId: 'c1',
      policy: 'required',
    });
    expect(views[1]).toMatchObject({ name: 'unknown', entryId: null, description: '' });
  });

  it('lets admins manage every marketplace and managers only their own team', () => {
    const me = (orgRole: string, teams: { id: string; role: string }[]) => ({ orgRole, teams });
    expect(canManageMarketplace({ ownerTeamId: null }, me('admin', []))).toBe(true);
    expect(
      canManageMarketplace({ ownerTeamId: null }, me('member', [{ id: 't1', role: 'manager' }])),
    ).toBe(false);
    expect(
      canManageMarketplace({ ownerTeamId: 't1' }, me('member', [{ id: 't1', role: 'manager' }])),
    ).toBe(true);
    expect(
      canManageMarketplace({ ownerTeamId: 't1' }, me('member', [{ id: 't1', role: 'member' }])),
    ).toBe(false);
  });

  it('totals the usage buckets per channel, largest first', () => {
    const totals = channelTotals([
      { ts: 'a', channel: 'git', action: 'fetch', count: 5 },
      { ts: 'b', channel: 'mirror', action: 'push', count: 9 },
      { ts: 'c', channel: 'git', action: 'fetch', count: 6 },
    ]);
    expect(totals).toEqual([
      { channel: 'git', label: 'Git clients', count: 11 },
      { channel: 'mirror', label: 'Mirror', count: 9 },
    ]);
  });

  it('summarises the mirror from its target and state', () => {
    const mirror = {
      provider: 'github' as const,
      repo: 'acme/x',
      branch: 'main',
      credentialSecretId: 's',
    };
    const state = (status: Schemas['MirrorState']['status']): Schemas['MirrorState'] => ({
      status,
      lastPushedSeq: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: 'now',
    });
    expect(mirrorSummary({ mirror: null, status: null, updatedAt: '' }).label).toBe(
      'No mirror configured',
    );
    expect(mirrorSummary({ mirror, status: state('ok'), updatedAt: '' })).toMatchObject({
      target: 'github.com/acme/x',
      tone: 'ok',
      needsPush: false,
    });
    expect(mirrorSummary({ mirror, status: state('diverged'), updatedAt: '' })).toMatchObject({
      tone: 'bad',
      needsPush: true,
    });
    expect(mirrorSummary({ mirror, status: null, updatedAt: '' }).needsPush).toBe(true);
  });

  it('reads the set up command off the rollout configuration', () => {
    expect(
      toClientSetup({
        client: 'claude-code',
        strictKnownMarketplacesEntry: { source: 'git', url: 'https://h/plugins/acme.git' },
      }).command,
    ).toBe('/plugin marketplace add https://h/plugins/acme.git');
    expect(
      toClientSetup({ client: 'codex', commands: ['codex plugin marketplace add u'] }).command,
    ).toBe('codex plugin marketplace add u');
    expect(toClientSetup({ client: 'chatgpt', steps: ['Import the repo'] })).toMatchObject({
      command: null,
      note: 'Import the repo',
    });
  });

  it('renders rollout configurations as copyable text', () => {
    expect(
      rolloutText({ client: 'codex', commands: ['a'], requirementsToml: '[marketplaces]' }),
    ).toEqual({ kind: 'snippet', text: 'a\n\n[marketplaces]' });
    const checklist = rolloutText({
      client: 'chatgpt',
      steps: ['One'],
      plugins: [{ name: 'p', setTo: 'Required' }],
    });
    expect(checklist.kind).toBe('checklist');
    expect(checklist.text).toContain('1. One');
    expect(checklist.text).toContain('p: Required');
  });
});
