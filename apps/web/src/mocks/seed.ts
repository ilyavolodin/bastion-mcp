/**
 * The constants every mock domain seeds from: the signed-in user, the people and teams of the Acme org and the org
 * settings the `/me` response repeats. One definition each, so a rename is one edit.
 */

/** The signed-in user of the mock (`GET /me`). */
export const ME_ID = 'u-dana';
export const PLATFORM_TEAM_ID = 't-platform';
export const PLATFORM_TEAM_NAME = 'Platform team';
export const PLATFORM_TEAM_SLUG = 'platform';

/** The people of the seeded org: id, display name and org role. */
export const SEED_PEOPLE = [
  [ME_ID, 'Dana Whitfield', 'admin'],
  ['u-raj', 'Raj Mehta', 'member'],
  ['u-jo', 'Jo Okafor', 'member'],
  ['u-ana', 'Ana Kim', 'member'],
  ['u-li', 'Li Chen', 'member'],
  ['u-sam', 'Sam Patel', 'member'],
  ['u-eve', 'Eve Torres', 'member'],
  ['u-max', 'Max Rivera', 'member'],
  ['u-ivy', 'Ivy Nguyen', 'member'],
  ['u-ben', 'Ben Stone', 'member'],
  ['u-kai', 'Kai Lee', 'member'],
  ['u-zoe', 'Zoe Fox', 'member'],
  ['u-tom', 'Tom Hart', 'member'],
  ['u-uma', 'Uma Gupta', 'auditor'],
] as const;

/** People who place tool calls: everybody but the auditor. */
export const CALLER_IDS = SEED_PEOPLE.filter(([, , role]) => role !== 'auditor').map(([id]) => id);

export const ORG_NAME = 'Acme Corp';
export const ORG_HOST = 'bastion.acme.dev';
export const TOOL_WARN_THRESHOLD = 40;
export const INTERNAL_REGISTRY_NAME = 'Acme internal registry';

/** The ids of the seeded rows that other domains point at, so a reference is a name, not a repeated literal. */
export const SEED_IDS = {
  installation: {
    github: 'i-github',
    jira: 'i-jira',
    linear: 'i-linear',
    postgres: 'i-postgres',
    sentry: 'i-sentry',
    slack: 'i-slack',
    notion: 'i-notion',
    filesystem: 'i-filesystem',
    zendesk: 'i-zendesk',
    webFetch: 'i-webfetch',
  },
  catalogEntry: { jira: 'c-jira', postgres: 'c-postgres', slack: 'c-slack' },
} as const;
