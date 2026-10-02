import { describe, expect, it } from 'vitest';
import {
  addTo,
  buildDirectory,
  describeMapsTo,
  filterUsers,
  oauthName,
  oauthStatus,
  removeWhat,
  removeWhen,
  removeWho,
  sourceOf,
  whatChips,
  whenChips,
  whoChips,
} from '@/api/views/access';
import { buildAccessData } from '@/mocks/domains/access';

const NOW = Date.UTC(2026, 5, 1);
const data = buildAccessData(NOW);
const dir = buildDirectory(data.users, data.teams);
const lookups = {
  teams: dir.teams,
  users: dir.users,
  serviceAccounts: data.serviceAccounts.map((s) => ({ id: s.id, name: s.displayName })),
  installations: [{ id: 'i-slack', displayName: 'Slack' }],
};

describe('access views (10, 17.2)', () => {
  it("10.1 derives a person's teams from the team memberships", () => {
    const raj = dir.users.find((u) => u.id === 'u-raj');
    expect(raj?.teams.map((t) => `${t.id}:${t.role}`).sort()).toEqual([
      't-data:manager',
      't-platform:member',
    ]);
    expect(raj?.name).toBe('Raj Mehta');
  });

  it('10.1 names members and managers of a team from the people list', () => {
    const support = dir.teams.find((t) => t.id === 't-support');
    expect(support?.managers).toEqual(['Ana Kim']);
    expect(support?.memberCount).toBe(3);
    expect(support?.name).toBe('Support');
    expect(support?.members.map((m) => m.name)).toContain('Max Rivera');
  });

  it('9.1 derives the source of a person from SCIM and IdP identifiers', () => {
    expect(sourceOf({ idpConnectionId: 'idp-1', scimExternalId: 'x' })).toBe('scim');
    expect(sourceOf({ idpConnectionId: 'idp-1', scimExternalId: null })).toBe('idp');
    expect(sourceOf({ idpConnectionId: null, scimExternalId: null })).toBe('manual');
  });

  it('17.2 filters people by text and by team', () => {
    expect(filterUsers(dir.users, { q: 'kim' }).map((u) => u.id)).toEqual(['u-ana']);
    expect(filterUsers(dir.users, { teamId: 't-analytics' }).map((u) => u.id)).toEqual([
      'u-jo',
      'u-sam',
    ]);
  });

  it('9.1 describes what a mapping rule does', () => {
    expect(describeMapsTo({ orgRole: 'auditor' }, dir.teams)).toEqual({
      kind: 'role',
      label: 'auditor',
    });
    expect(describeMapsTo({ teamId: 't-data', teamRole: 'manager' }, dir.teams).label).toBe(
      'Data platform · manager',
    );
    expect(describeMapsTo({ createTeam: true }, dir.teams).label).toBe('A team per group · member');
  });

  it('9.4 derives the status of an OAuth client from its policy flags', () => {
    expect(oauthStatus({ blocked: true, preApproved: true })).toBe('blocked');
    expect(oauthStatus({ blocked: false, preApproved: true })).toBe('approved');
    expect(oauthStatus({ blocked: false, preApproved: false })).toBe('pending');
    expect(oauthName('https://claude.ai/oauth/client.json')).toBe('claude.ai');
    expect(oauthName('cursor-desktop')).toBe('cursor-desktop');
  });

  it('10.3 turns a rule into readable chips and says everyone when nobody is named', () => {
    expect(whoChips({}, lookups)).toEqual([{ key: 'everyone', label: 'Everyone' }]);
    expect(whoChips({ role: 'member', teams: ['t-support'] }, lookups).map((c) => c.label)).toEqual(
      ['Role · Member', 'Team · Support'],
    );
    expect(
      whatChips(
        { installationId: 'i-slack', toolName: 'slack_post_*', annotations: { destructive: true } },
        lookups,
      ).map((c) => c.label),
    ).toEqual(['Slack', 'slack_post_*', 'destructive tools']);
    expect(whatChips({}, lookups)).toEqual([{ key: 'any', label: 'Any tool' }]);
    expect(
      whenChips({
        hours: { from: 8, to: 19 },
        weekdays: [5, 1],
        ipCidrs: ['10.0.0.0/8'],
        clientIds: ['claude-code'],
      }).map((c) => c.label),
    ).toEqual(['Hours 08:00–19:00', 'Mon, Fri', 'Client · claude-code', 'IP · 10.0.0.0/8']);
  });

  it('10.3 removes the chip it is asked to and drops emptied fields', () => {
    expect(removeWho({ role: 'member', teams: ['a', 'b'] }, 'team:a')).toEqual({
      role: 'member',
      teams: ['b'],
    });
    expect(removeWho({ teams: ['a'] }, 'team:a')).toEqual({});
    expect(removeWho({ role: 'admin' }, 'role:admin')).toEqual({});
    expect(
      removeWhat(
        { installationId: 'i', toolName: 't', annotations: { destructive: true } },
        'tool:t',
      ),
    ).toEqual({ installationId: 'i', annotations: { destructive: true } });
    expect(removeWhat({ annotations: { destructive: true } }, 'ann:destructive')).toEqual({});
    expect(removeWhen({ weekdays: [1], hours: { from: 1, to: 2 } }, 'hours')).toEqual({
      weekdays: [1],
    });
    expect(
      removeWhen(
        {
          args: [
            { op: 'exists', name: 'a' },
            { op: 'exists', name: 'b' },
          ],
        },
        'arg:0',
      ),
    ).toEqual({ args: [{ op: 'exists', name: 'b' }] });
  });

  it('10.3 adds a value once', () => {
    expect(addTo(['a'], 'a')).toEqual(['a']);
    expect(addTo(undefined, 'a')).toEqual(['a']);
  });
});
