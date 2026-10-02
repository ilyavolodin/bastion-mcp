import { type GuardProfile, guardProfileSchema } from './types';

/**
 * The org default guard profile, shipped enabled (13.7, 22.5): `unicode` (redact, all phases), `size`,
 * `regex` `secrets` (redact on responses, warn on requests), `regex` `injection-heuristics` (warn) and
 * definition pinning with `hideChanged`. Model guards are added by an admin and are off by default.
 */
export const ORG_DEFAULT_PROFILE: GuardProfile = Object.freeze(
  guardProfileSchema.parse({
    profileId: 'org-default',
    onDrift: 'hideChanged',
    guards: [
      { instanceId: 'org-default:unicode', type: 'unicode', config: {} },
      { instanceId: 'org-default:size', type: 'size', config: {} },
      {
        instanceId: 'org-default:secrets',
        type: 'regex',
        config: {
          presets: {
            secrets: { actions: { request: 'warn', response: 'redact', definition: 'warn' } },
          },
        },
      },
      {
        instanceId: 'org-default:injection-heuristics',
        type: 'regex',
        config: { presets: { 'injection-heuristics': true } },
      },
    ],
  }),
);
