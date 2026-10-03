import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOURS_FROM,
  DEFAULT_HOURS_TO,
  DEFAULT_RULE_PRIORITY,
  type PolicyRule,
  ruleDraftOf,
} from './rule-draft';

describe('rule form (10.2)', () => {
  it('a new rule forbids for everyone and every tool, at the default priority', () => {
    expect(ruleDraftOf(null)).toEqual({
      name: '',
      priority: String(DEFAULT_RULE_PRIORITY),
      ownerTeamId: '',
      effect: 'forbid',
      who: {},
      what: {},
      when: {},
    });
  });

  it('the working day picker starts from 08:00 to 19:00', () => {
    expect([DEFAULT_HOURS_FROM, DEFAULT_HOURS_TO]).toEqual([8, 19]);
  });

  it('an existing rule fills the form from its own fields', () => {
    const rule = {
      id: 'r1',
      name: 'No deletes',
      priority: 5,
      ownerTeamId: 't1',
      effect: 'permit',
      who: { role: 'member' },
      what: { toolName: 'delete_*' },
      when: { weekdays: [1, 2] },
      enabled: false,
    } as unknown as PolicyRule;
    expect(ruleDraftOf(rule)).toEqual({
      name: 'No deletes',
      priority: '5',
      ownerTeamId: 't1',
      effect: 'permit',
      who: { role: 'member' },
      what: { toolName: 'delete_*' },
      when: { weekdays: [1, 2] },
    });
  });

  it('a team-less rule has an empty owner and a priority of 0 is kept', () => {
    const rule = {
      id: 'r',
      name: 'x',
      priority: 0,
      ownerTeamId: null,
      effect: 'forbid',
    } as unknown as PolicyRule;
    const d = ruleDraftOf(rule);
    expect(d.ownerTeamId).toBe('');
    expect(d.priority).toBe('0');
  });
});
