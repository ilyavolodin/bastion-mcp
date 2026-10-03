/** The seeded installations as data (`seed.ts` turns them into rows). */

import { ME_ID, PLATFORM_TEAM_ID, SEED_IDS } from '../../seed';
import type { Installation } from './types';

const ME = ME_ID;

export type Seed = {
  id: string;
  entry: string;
  slug: string;
  name: string;
  version: string;
  status: Installation['status'];
  /** `u-...` or `t-...` */
  owner: string;
  detail?: string;
  variables?: Record<string, string>;
  secrets?: string[];
  overrides?: Record<string, unknown>;
};

export const SEEDS: Seed[] = [
  {
    id: SEED_IDS.installation.github,
    entry: 'github',
    slug: 'github',
    name: 'GitHub',
    version: '2.4.0',
    status: 'needs_setup',
    owner: ME,
  },
  {
    id: SEED_IDS.installation.jira,
    entry: 'jira',
    slug: 'jira',
    name: 'Jira',
    version: '1.8.2',
    status: 'ready',
    owner: ME,
    variables: { SITE_URL: 'https://acme.atlassian.net' },
  },
  {
    id: SEED_IDS.installation.linear,
    entry: 'linear',
    slug: 'linear',
    name: 'Linear',
    version: '1.2.0',
    status: 'ready',
    owner: PLATFORM_TEAM_ID,
  },
  {
    id: SEED_IDS.installation.postgres,
    entry: 'postgres',
    slug: 'pg-analytics',
    name: 'Postgres analytics',
    version: '3.2.0',
    status: 'ready',
    owner: 't-data',
    secrets: ['DATABASE_URL'],
    overrides: {
      version: 1,
      tools: {
        pg_run_query: {
          description: { mode: 'append', text: 'Queries run on the analytics replica.' },
          annotations: { readOnlyHint: true },
        },
        pg_describe_table: { title: 'Describe a table' },
        pg_write_rows: { hidden: true },
      },
    },
  },
  {
    id: SEED_IDS.installation.sentry,
    entry: 'sentry',
    slug: 'sentry',
    name: 'Sentry',
    version: '4.3.0',
    status: 'reconnect_required',
    owner: ME,
  },
  {
    id: SEED_IDS.installation.slack,
    entry: 'slack',
    slug: 'slack',
    name: 'Slack',
    version: '2.0.1',
    status: 'ready',
    owner: ME,
  },
  {
    id: SEED_IDS.installation.notion,
    entry: 'notion',
    slug: 'notion',
    name: 'Notion',
    version: '1.0.4',
    status: 'needs_setup',
    owner: ME,
  },
  {
    id: SEED_IDS.installation.filesystem,
    entry: 'filesystem',
    slug: 'filesystem',
    name: 'Filesystem',
    version: '0.6.2',
    status: 'error',
    owner: ME,
    detail: 'The server exited with code 1 while starting.',
  },
  {
    id: SEED_IDS.installation.zendesk,
    entry: 'zendesk',
    slug: 'zendesk',
    name: 'Zendesk',
    version: '1.1.0',
    status: 'ready',
    owner: ME,
    secrets: ['ZENDESK_TOKEN'],
  },
  {
    id: SEED_IDS.installation.webFetch,
    entry: 'web-fetch',
    slug: 'web-fetch',
    name: 'Web fetch',
    version: '2025.4.1',
    status: 'ready',
    owner: ME,
  },
];
