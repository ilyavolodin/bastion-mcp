import { describe, expect, it } from 'vitest';
import {
  createGuardRegistry,
  deterministicGuards,
  GuardPipeline,
  guardProfileSchema,
  ORG_DEFAULT_PROFILE,
} from '../src';
import { FakeClock, input, seg } from './helpers';

describe('13.1 guard registry', () => {
  it('13.1 registers only the deterministic guards without model deps', () => {
    expect(deterministicGuards().map((g) => g.type)).toEqual([
      'unicode',
      'size',
      'regex',
      'pii',
      'url',
    ]);
    expect(createGuardRegistry().map((g) => g.type)).toEqual(
      deterministicGuards().map((g) => g.type),
    );
  });

  it('13.5 adds the three model guards when model deps are given', () => {
    const types = createGuardRegistry({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
      secrets: { resolve: async () => 'k' },
    }).map((g) => g.type);
    expect(types).toEqual([
      'unicode',
      'size',
      'regex',
      'pii',
      'url',
      'classifier',
      'jev',
      'llmJudge',
    ]);
  });
});

describe('13.7 org default profile', () => {
  it('13.7 ships unicode, size, secrets and injection heuristics, no model guards', () => {
    expect(ORG_DEFAULT_PROFILE.profileId).toBe('org-default');
    expect(ORG_DEFAULT_PROFILE.onDrift).toBe('hideChanged');
    expect(ORG_DEFAULT_PROFILE.guards.map((g) => g.instanceId)).toEqual([
      'org-default:unicode',
      'org-default:size',
      'org-default:secrets',
      'org-default:injection-heuristics',
    ]);
    expect(
      ORG_DEFAULT_PROFILE.guards.every((g) => g.type !== 'classifier' && g.type !== 'llmJudge'),
    ).toBe(true);
  });

  it('24.2 is frozen and valid under the profile schema', () => {
    expect(Object.isFrozen(ORG_DEFAULT_PROFILE)).toBe(true);
    expect(() => guardProfileSchema.parse(ORG_DEFAULT_PROFILE)).not.toThrow();
  });

  it('13.7 redacts a secret in a response and passes clean text', async () => {
    const pipeline = new GuardPipeline({ guards: deterministicGuards(), clock: new FakeClock() });
    const clean = await pipeline.run(input('response', [seg('hello world')]), {
      org: ORG_DEFAULT_PROFILE,
    });
    expect(clean.action).toBe('allow');
    const leaked = await pipeline.run(
      input('response', [seg('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')]),
      { org: ORG_DEFAULT_PROFILE },
    );
    expect(leaked.action).toBe('redact');
  });
});
