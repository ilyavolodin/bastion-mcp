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
        'claude mcp add --transport http bastion-default https://bastion.acme.dev/mcp',
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
        db.data.servers.installations = [];
      },
    });
    expect(await screen.findByText('Install your first server')).toBeInTheDocument();
  });
});

describe('Store and install flow (11.2, 11.4)', () => {
  it('opens the drawer with what you will need, where the server reaches and its version', async () => {
    const { user } = await renderRoute('/store');
    await user.click(await screen.findByRole('button', { name: 'Jira' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Jira sign-in')).toBeInTheDocument();
    expect(within(dialog).getByText('mcp.jira.example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('1 setting')).toBeInTheDocument();
    expect(within(dialog).getByText(/v1\.8\.2/)).toBeInTheDocument();
  });

  it('searches names and descriptions so "pull requests" finds GitHub', async () => {
    const { user } = await renderRoute('/store');
    await screen.findByRole('button', { name: 'Jira' });
    await user.type(screen.getByRole('searchbox', { name: 'Search the store' }), 'pull requests');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Linear' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'GitHub' })).toBeInTheDocument();
  });

  it('installs an OAuth server: setup, connect, ready with a copyable config', async () => {
    const { user } = await renderRoute('/store?entry=servicedesk');
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install ServiceDesk/ });
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    await user.click(await screen.findByRole('button', { name: /Connect with ServiceDesk/ }));
    expect(await screen.findByRole('dialog', { name: /ServiceDesk is ready/ })).toBeInTheDocument();
    expect((await screen.findAllByText(/"mcpServers"/)).length).toBeGreaterThan(0);
    expect(
      getDb().data.servers.installations.some(
        (i) => i.slug === 'servicedesk' && i.status === 'ready',
      ),
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
        const jira = db.data.servers.upstream['i-jira'];
        if (jira)
          jira.tools = Array.from({ length: 60 }, (_, n) => ({
            name: `tool_${n}`,
            description: 'A tool',
            inputSchema: { type: 'object' },
          }));
      },
    });
    expect(await screen.findAllByText(/tools is a lot/)).not.toHaveLength(0);
  });

  it('shows markers for overridden items in Capabilities and leaves hidden ones out', async () => {
    await renderRoute('/servers/i-postgres?tab=capabilities');
    await screen.findByText('pg_run_query');
    expect(screen.getAllByLabelText('Overridden').length).toBeGreaterThan(0);
    expect(screen.queryByText('pg_write_rows')).toBeNull();
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
    await user.type(await screen.findByLabelText('sql *'), 'select 1');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByLabelText('Result')).toHaveTextContent('"rows"');
  });

  it('10.1 a member neither lists nor opens a team installation', async () => {
    await renderRoute('/servers/i-postgres', { role: 'member' });
    expect((await screen.findAllByText(/Installation not found/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });

  it('Connection never shows secret values and Network lists allowed and denied hosts', async () => {
    const { user } = await renderRoute('/servers/i-postgres?tab=connection');
    expect(await screen.findByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('Values are never shown.', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Network' }));
    expect(await screen.findByText('warehouse.acme.internal')).toBeInTheDocument();
    expect(screen.getAllByText('Denied').length).toBeGreaterThan(0);
  });

  it('11.4 an installation that is not pinned shows the version it runs (the newest published), not the one it was installed at', async () => {
    await renderRoute('/servers/i-postgres', {
      prepare: (db) => {
        const entry = db.data.catalog.entries.find((e) => e.id === 'c-postgres');
        const installed = db.data.catalog.versions.find((v) => v.entryId === 'c-postgres');
        if (!entry || !installed) throw new Error('fixture missing');
        // The entry published a newer version after this installation was created.
        db.data.catalog.versions.push({
          ...installed,
          id: 'v-postgres-3.3.0',
          label: '3.3.0',
          status: 'published',
        });
        entry.currentVersionId = 'v-postgres-3.3.0';
      },
    });
    expect(await screen.findByText(/3\.3\.0/)).toBeInTheDocument();
    expect(screen.getByText('Updates itself')).toBeInTheDocument();
    expect(screen.queryByText(/Pinned/)).toBeNull();
  });

  it('11.4 a pinned installation says which newer version is available', async () => {
    await renderRoute('/servers/i-postgres', {
      prepare: (db) => {
        const entry = db.data.catalog.entries.find((e) => e.id === 'c-postgres');
        const installed = db.data.catalog.versions.find((v) => v.entryId === 'c-postgres');
        const row = db.data.servers.installations.find((i) => i.id === 'i-postgres');
        if (!entry || !installed || !row) throw new Error('fixture missing');
        db.data.catalog.versions.push({
          ...installed,
          id: 'v-postgres-3.3.0',
          label: '3.3.0',
          status: 'published',
        });
        entry.currentVersionId = 'v-postgres-3.3.0';
        row.pinnedVersion = true;
      },
    });
    expect(await screen.findByText('Pinned · v3.3.0 is available')).toBeInTheDocument();
    expect(screen.queryByText('Updates itself')).toBeNull();
  });

  it('removing a server goes straight to the list: the removed server’s page never shows "not found"', async () => {
    const { user } = await renderRoute('/servers/i-slack?tab=settings');
    await user.click(await screen.findByRole('button', { name: 'Remove server' }));
    // The page of the deleted row answers 404 once the lists refresh: it must be gone from the screen by then.
    let sawNotFound = false;
    const watch = () => {
      if (document.body.textContent?.includes('Installation not found')) sawNotFound = true;
    };
    const observer = new MutationObserver(watch);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByRole('heading', { level: 1, name: /servers/i });
    await waitFor(() =>
      expect(getDb().data.servers.installations.some((i) => i.id === 'i-slack')).toBe(false),
    );
    // Give the list refresh time to settle, then look at what was shown along the way.
    await new Promise((r) => setTimeout(r, 300));
    observer.disconnect();
    expect(sawNotFound).toBe(false);
  });

  it('Settings saves with If-Match and removes the server', async () => {
    const { user } = await renderRoute('/servers/i-slack?tab=settings');
    await user.click((await screen.findAllByRole('switch', { name: 'Enabled' }))[0] as HTMLElement);
    await waitFor(() =>
      expect(getDb().data.servers.installations.find((i) => i.id === 'i-slack')?.enabled).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Remove server' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(getDb().data.servers.installations.some((i) => i.id === 'i-slack')).toBe(false),
    );
  });
});

describe('Activity (15.5, 18.3)', () => {
  it('opens a call drawer with the guard result, policy reasons, previews and tracing link', async () => {
    const { user } = await renderRoute('/activity');
    const rows = await screen.findAllByRole('button', { name: /pg_run_query/ });
    await user.click(rows[0]!);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('sql-write-guard')).toBeInTheDocument();
    expect(within(drawer).getByText(/regex guard · request · Blocked/)).toBeInTheDocument();
    expect(within(drawer).getByText('malicious')).toBeInTheDocument();
    expect(within(drawer).getByText('rule-data-readers')).toBeInTheDocument();
    expect(within(drawer).getByText('GUARD_BLOCKED')).toBeInTheDocument();
    expect(within(drawer).getByText(/SELECT \* FROM orders/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Open in tracing backend/ })).toHaveAttribute(
      'href',
      expect.stringMatching(/traces\.acme\.dev\/trace\/[0-9a-f]{32}$/),
    );
    expect(within(drawer).getByText('Cold start').nextElementSibling).toHaveTextContent('Yes');
  });

  it('15.5 the calls-over-time strip has time labels, first and last bucket included', async () => {
    await renderRoute('/activity', { role: 'member' });
    const card = (await screen.findByRole('heading', { name: 'Calls over time' })).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() =>
      expect(card.querySelectorAll('[title$=" calls"]').length).toBeGreaterThan(0),
    );
    const bars = [...card.querySelectorAll('[title$=" calls"]')].map((b) =>
      (b.getAttribute('title') ?? '').split(':').slice(0, -1).join(':'),
    );
    // The axis under the bars shows the time of the first and of the last bar (clock times: `10:30`).
    const axis = card.querySelector('.tabular-nums.text-muted') as HTMLElement;
    expect(axis).toBeTruthy();
    expect(axis.textContent).toContain(bars[0]?.trim());
    expect(axis.textContent).toContain(bars[bars.length - 1]?.trim());
    expect(axis.querySelectorAll('span').length).toBeGreaterThanOrEqual(2);
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
    const { user } = await renderRoute('/activity?outcome=input_required');
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
