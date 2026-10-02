import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { expectNoA11yViolations, renderRoute } from './utils';

describe('Home (18.3)', () => {
  it('shows the endpoint, one-click client configs, tiles with one next action and quotas', async () => {
    const { user } = await renderRoute('/');
    expect(await screen.findByText('https://bastion.acme.dev/mcp')).toBeInTheDocument();
    expect(screen.getByText(/GitHub isn’t connected yet/)).toBeInTheDocument();
    expect(await screen.findByText('Add API key')).toBeInTheDocument();
    expect(screen.getByText('See why')).toBeInTheDocument();
    expect(await screen.findByText('3,760 left of 5,000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Claude Code/ }));
    expect(
      await screen.findByText(
        'claude mcp add --transport http bastion https://bastion.acme.dev/mcp',
      ),
    ).toBeInTheDocument();
  });

  it('18.1 status is never colour alone: every tile status has an icon and text', async () => {
    await renderRoute('/');
    const tile = (await screen.findByText('Reconnect required')).closest('div');
    expect(tile?.querySelector('svg')).not.toBeNull();
  });

  it('10.1 members do not see the decisions or team cards', async () => {
    await renderRoute('/', { role: 'member' });
    await screen.findByText('Connect your AI tools');
    expect(screen.queryByText('Needs your decision')).toBeNull();
    expect(screen.queryByLabelText('Team adoption')).toBeNull();
  });

  it('shows the one next action when there is nothing installed', async () => {
    await renderRoute('/', {
      prepare: (db) => {
        db.installations = [];
      },
    });
    expect(await screen.findByText('Install your first server')).toBeInTheDocument();
  });
});

describe('Store and install flow (11.2, 11.4)', () => {
  it('opens the drawer with tools, setup needs and egress hosts', async () => {
    const { user } = await renderRoute('/store');
    await user.click(await screen.findByRole('button', { name: 'Jira' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('search_issues')).toBeInTheDocument();
    expect(within(dialog).getByText('Atlassian sign-in')).toBeInTheDocument();
    expect(within(dialog).getByText('mcp.atlassian.com')).toBeInTheDocument();
    expect(within(dialog).getByText('Destructive')).toBeInTheDocument();
  });

  it('searches tool names so "create ticket" style queries find servers', async () => {
    const { user } = await renderRoute('/store');
    await screen.findByRole('button', { name: 'Jira' });
    await user.type(screen.getByRole('searchbox', { name: 'Search the store' }), 'transition');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Linear' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Jira' })).toBeInTheDocument();
  });

  it('installs an OAuth server: setup, connect, ready with a copyable config', async () => {
    const { user } = await renderRoute('/store?entry=servicedesk');
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install ServiceDesk/ });
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    await user.click(
      await screen.findByRole('button', { name: /Connect with ServiceDesk sign-in/ }),
    );
    expect(await screen.findByRole('dialog', { name: /ServiceDesk is ready/ })).toBeInTheDocument();
    expect((await screen.findAllByText(/"mcpServers"/)).length).toBeGreaterThan(0);
    expect(
      getDb().installations.some((i) => i.slug === 'servicedesk' && i.status === 'ready'),
    ).toBe(true);
  });

  it('validates the install form and reports problem+json field errors', async () => {
    const { user } = await renderRoute('/store?entry=hubspot');
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install HubSpot/ });
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(await within(dialog).findByText('API key is required')).toBeInTheDocument();
  });
});

describe('My servers and Installation detail (18.3)', () => {
  it('flags an endpoint over the tool-count threshold', async () => {
    await renderRoute('/servers?tab=endpoints', {
      prepare: (db) => {
        const e = db.endpoints[0];
        if (e) e.toolCount = 99;
      },
    });
    expect(await screen.findByText(/99 tools is a lot/)).toBeInTheDocument();
  });

  it('shows markers for overridden, hidden and guarded items in Capabilities', async () => {
    await renderRoute('/servers/i-postgres?tab=capabilities');
    await screen.findByText('pg_write_rows');
    expect(screen.getAllByLabelText('Overridden').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Hidden').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Guarded').length).toBeGreaterThan(0);
  });

  it('12.5 shows upstream and final definitions side by side and validates raw JSON', async () => {
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    expect(await screen.findByText('Upstream definition')).toBeInTheDocument();
    expect(await screen.findByText('Final definition')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raw JSON' }));
    const editor = await screen.findByLabelText('Override document JSON');
    await user.clear(editor);
    await user.click(editor);
    await user.paste('{"version":1,"tools":{"pg_explain":{"name":"bad name"}}}');
    const errors = await screen.findByRole('alert', { name: 'Validation errors' });
    expect(errors).toHaveTextContent('tools.pg_explain.name');
    expect(screen.getByRole('button', { name: 'Save overrides' })).toBeDisabled();
  });

  it('12.5 the Try it panel calls the tool through the final definition', async () => {
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    await screen.findByText('Final definition');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('pg_run_query'),
    );
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByLabelText('Result')).toHaveTextContent('"rows"');
  });

  it('shows the read-only banner and hides edit tabs for a member on a team install', async () => {
    await renderRoute('/servers/i-postgres', { role: 'member' });
    expect(await screen.findByText(/team manages this server/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Overrides' })).toBeNull();
  });

  it('Connection never shows secret values and Network lists allowed and denied hosts', async () => {
    const { user } = await renderRoute('/servers/i-postgres?tab=connection');
    expect(await screen.findByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('Values are never shown.', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Network' }));
    expect(await screen.findByText('warehouse.acme.internal')).toBeInTheDocument();
    expect(screen.getAllByText('Denied').length).toBeGreaterThan(0);
  });

  it('Settings saves with If-Match and removes the server', async () => {
    const { user } = await renderRoute('/servers/i-slack?tab=settings');
    await user.click((await screen.findAllByRole('switch', { name: 'Enabled' }))[0]!);
    await waitFor(() =>
      expect(getDb().installations.find((i) => i.id === 'i-slack')?.enabled).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: 'Remove server' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(getDb().installations.some((i) => i.id === 'i-slack')).toBe(false));
  });
});

describe('Activity (15.5, 18.3)', () => {
  it('opens a call drawer with the trace waterfall, guard finding, policy and tracing link', async () => {
    const { user } = await renderRoute('/activity');
    const rows = await screen.findAllByRole('button', { name: /pg_run_query/ });
    await user.click(rows[0]!);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Where the time went')).toBeInTheDocument();
    expect(within(drawer).getByText(/Request guard · SQL write pattern/)).toBeInTheDocument();
    expect(within(drawer).getByText('DROP TABLE').tagName).toBe('MARK');
    expect(within(drawer).getByText(/data-readers may call/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Open in tracing backend/ })).toHaveAttribute(
      'href',
      expect.stringContaining('traces.acme.dev'),
    );
    expect(within(drawer).getByLabelText('Cold start phases')).toBeInTheDocument();
  });

  it('10.1 members only see their own calls and no person filter', async () => {
    await renderRoute('/activity', { role: 'member' });
    await screen.findByText('Your calls');
    expect(screen.queryByLabelText('Person')).toBeNull();
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /Raj Mehta/ })).toHaveLength(0),
    );
  });

  it('filters by outcome and offers a way out of an empty result', async () => {
    const { user } = await renderRoute('/activity?outcome=rate_limited');
    expect(await screen.findByText('No calls match')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect((await screen.findAllByRole('button', { name: /tools\/call/ })).length).toBeGreaterThan(
      0,
    );
  });

  it('a11y: Activity has no axe violations', async () => {
    const { container } = await renderRoute('/activity');
    await screen.findAllByRole('button', { name: /pg_run_query/ });
    expect(await expectNoA11yViolations(container)).toHaveNoViolations();
  });
});
