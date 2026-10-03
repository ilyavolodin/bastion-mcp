/** The seeded Acme catalog as data: one row per entry (`seed.ts` turns them into entries, versions and files). */
import type { Entry, Version } from './types';

export type Seed = {
  slug: string;
  name: string;
  kind: Entry['kind'];
  desc: string;
  label: string;
  risk?: Entry['risk'];
  owner?: { id: string; teams: string[] };
  draft?: boolean;
  spec: 'oauth' | 'userSecret' | 'package' | 'none';
  registry?: boolean;
  /** A draft version in addition to the published one. */
  extraDraft?: string;
  /** The `userSecret` field of the sign-in (default: the Zendesk token). */
  secret?: { name: string; label: string };
  /** A package spec (default: the Postgres one). */
  pkg?: { runtime: 'npm' | 'pypi'; identifier: string; version: string; egress: string[] };
  /** What the installer fills in, when the spec derives none. */
  form?: Version['installForm'];
};

export const SEEDS: Seed[] = [
  {
    slug: 'jira',
    name: 'Jira',
    kind: 'mcp_server',
    desc: 'Issues, projects and sprints',
    label: '1.8.2',
    spec: 'oauth',
    registry: true,
    form: {
      variables: [
        {
          name: 'SITE_URL',
          label: 'Jira site',
          description: 'Your Atlassian cloud address',
          required: true,
          default: 'https://acme.atlassian.net',
        },
      ],
      secrets: [],
    },
  },
  {
    slug: 'linear',
    name: 'Linear',
    kind: 'mcp_server',
    desc: 'Issues and cycles for product teams',
    label: '1.2.0',
    spec: 'oauth',
  },
  {
    slug: 'github',
    name: 'GitHub',
    kind: 'mcp_server',
    desc: 'Repos, pull requests and issues',
    label: '2.4.0',
    spec: 'oauth',
    risk: 'medium',
  },
  {
    slug: 'postgres',
    name: 'Postgres analytics',
    kind: 'mcp_server',
    desc: 'Read-only SQL on the warehouse',
    label: '3.2.0',
    spec: 'package',
    risk: 'medium',
    draft: true,
    owner: { id: 't-data', teams: ['t-data', 't-analytics'] },
  },
  {
    slug: 'zendesk',
    name: 'Zendesk',
    kind: 'mcp_server',
    desc: 'Support tickets and macros',
    label: '1.1.0',
    spec: 'userSecret',
    owner: { id: 't-support', teams: [] },
  },
  {
    slug: 'slack',
    name: 'Slack',
    kind: 'mcp_server',
    desc: 'Messages and channels',
    label: '2.0.1',
    spec: 'oauth',
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    kind: 'mcp_server',
    desc: 'Errors, events and releases',
    label: '4.3.0',
    spec: 'oauth',
    risk: 'medium',
  },
  {
    slug: 'release-notes',
    name: 'Release notes',
    kind: 'plugin',
    desc: 'Drafts notes from merged PRs',
    label: '1.4.0',
    spec: 'none',
  },
  {
    slug: 'incident-kit',
    name: 'Incident kit',
    kind: 'plugin',
    desc: 'Triage, timelines, postmortems',
    label: '2.0.0',
    spec: 'none',
    risk: 'medium',
    extraDraft: '2.1.0',
  },
  {
    slug: 'data-helpers',
    name: 'Data helpers',
    kind: 'plugin',
    desc: 'Warehouse queries with guardrails',
    label: '1.1.0',
    spec: 'none',
  },
  {
    slug: 'api-style',
    name: 'API style',
    kind: 'skill',
    desc: 'House rules for REST and events',
    label: '1.0.0',
    spec: 'none',
  },
  {
    slug: 'test-writer',
    name: 'Test writer',
    kind: 'plugin',
    desc: 'Generates and runs unit tests',
    label: '0.8.0',
    spec: 'none',
  },
  {
    slug: 'security-review',
    name: 'Security review',
    kind: 'plugin',
    desc: 'Checks diffs against our policy',
    label: '1.0.0',
    spec: 'none',
  },
  {
    slug: 'notion',
    name: 'Notion',
    kind: 'mcp_server',
    desc: 'Pages and databases',
    label: '1.0.4',
    spec: 'userSecret',
    secret: { name: 'NOTION_API_KEY', label: 'Notion API key' },
  },
  {
    slug: 'filesystem',
    name: 'Filesystem',
    kind: 'mcp_server',
    desc: 'Read and write files in a scratch workspace',
    label: '0.6.2',
    spec: 'package',
    pkg: {
      runtime: 'npm',
      identifier: '@modelcontextprotocol/server-filesystem',
      version: '0.6.2',
      egress: [],
    },
  },
  {
    slug: 'web-fetch',
    name: 'Web fetch',
    kind: 'mcp_server',
    desc: 'Fetch a web page as Markdown',
    label: '2025.4.1',
    spec: 'package',
    pkg: {
      runtime: 'pypi',
      identifier: 'mcp-server-fetch',
      version: '2025.4.1',
      egress: ['*.wikipedia.org', 'docs.acme.dev'],
    },
  },
  {
    slug: 'servicedesk',
    name: 'ServiceDesk',
    kind: 'mcp_server',
    desc: 'IT requests and approvals',
    label: '1.0.0',
    spec: 'oauth',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    kind: 'mcp_server',
    desc: 'Contacts, companies and deals',
    label: '3.1.0',
    spec: 'userSecret',
    secret: { name: 'HUBSPOT_API_KEY', label: 'API key' },
  },
  {
    slug: 'ticket-triage',
    name: 'Ticket triage',
    kind: 'mcp_server',
    desc: 'Internal triage helpers',
    label: '0.9.0',
    spec: 'package',
    pkg: { runtime: 'pypi', identifier: 'acme-ticket-triage', version: '0.9.0', egress: [] },
  },
];
