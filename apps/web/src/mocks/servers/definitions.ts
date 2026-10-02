/**
 * What the Acme servers list (upstream definitions the MSW mock serves), one set per catalog entry slug. The override
 * engine (`overrides-engine.ts`) turns them into the final definitions an installation serves.
 */

export type CapabilityItem = {
  kind: 'tool' | 'prompt' | 'resource' | 'template';
  name: string;
  description: string;
  access?: 'read' | 'write' | 'destructive';
};

const t = (
  name: string,
  description: string,
  access: CapabilityItem['access'],
): CapabilityItem => ({
  kind: 'tool',
  name,
  description,
  access,
});

export const ITEMS: Record<string, CapabilityItem[]> = {
  jira: [
    t('search_issues', 'Search issues with JQL or free text', 'read'),
    t('get_issue', 'Get one issue with its comments', 'read'),
    t('create_issue', 'Create an issue in a project', 'write'),
    t('update_issue', 'Update fields on an issue', 'write'),
    t('transition_issue', 'Move an issue to another status', 'write'),
    t('add_comment', 'Comment on an issue', 'write'),
    t('list_projects', 'List the projects you can see', 'read'),
    t('get_sprint', 'Get the active sprint of a board', 'read'),
    t('delete_issue', 'Delete an issue permanently', 'destructive'),
  ],
  linear: [
    t('list_issues', 'List issues for a team or cycle', 'read'),
    t('get_issue', 'Get an issue', 'read'),
    t('create_issue', 'Create an issue', 'write'),
    t('update_issue', 'Update an issue', 'write'),
    t('list_cycles', 'List cycles', 'read'),
  ],
  github: [
    t('list_pulls', 'List pull requests', 'read'),
    t('get_pull', 'Get a pull request with its diff', 'read'),
    t('create_pull_request', 'Open a pull request', 'write'),
    t('create_issue', 'Create an issue', 'write'),
    t('search_code', 'Search code across repositories', 'read'),
    t('delete_branch', 'Delete a branch', 'destructive'),
  ],
  postgres: [
    t('pg_run_query', 'Run a read-only SQL query on analytics', 'read'),
    t('pg_list_tables', 'List tables and views in a schema', 'read'),
    t('pg_describe_table', 'Columns, types and row estimates', 'read'),
    t('pg_explain', 'Explain a query plan', 'read'),
    t('pg_write_rows', 'Insert or update rows', 'destructive'),
    { kind: 'prompt', name: 'weekly_metrics', description: 'Prompt: summarize this week’s KPIs' },
    {
      kind: 'template',
      name: 'pg://{schema}/{table}',
      description: 'Rows of a table as a resource',
    },
  ],
  slack: [
    t('search_messages', 'Search messages', 'read'),
    t('read_channel', 'Read recent messages in a channel', 'read'),
    t('post_message', 'Post a message to a channel', 'write'),
    t('delete_message', 'Delete a message', 'destructive'),
  ],
  sentry: [
    t('get_event', 'Fetch a Sentry event by ID, with its stack trace and tags.', 'read'),
    t('list_issues', 'List issues for a project', 'read'),
    t('resolve_issue', 'Resolve an issue', 'write'),
  ],
  notion: [
    t('search', 'Search pages and databases', 'read'),
    t('get_page', 'Get a page', 'read'),
    t('create_page', 'Create a page', 'write'),
  ],
  filesystem: [
    t('read_file', 'Read a file in the scratch workspace', 'read'),
    t('write_file', 'Write a file in the scratch workspace', 'write'),
    t('list_directory', 'List a directory', 'read'),
  ],
  zendesk: [
    t('search_tickets', 'Search support tickets', 'read'),
    t('get_ticket', 'Get a ticket', 'read'),
    t('add_comment', 'Add a comment to a ticket', 'write'),
  ],
  'web-fetch': [t('fetch_url', 'Fetch a URL and return it as Markdown', 'read')],
  hubspot: [
    t('search_contacts', 'Search contacts', 'read'),
    t('create_deal', 'Create a deal', 'write'),
  ],
  servicedesk: [
    t('list_requests', 'List IT requests', 'read'),
    t('approve_request', 'Approve a request', 'write'),
  ],
  'ticket-triage': [t('triage_ticket', 'Suggest a priority and owner', 'read')],
};
