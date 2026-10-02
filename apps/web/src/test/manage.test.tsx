import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { expectNoA11yViolations, renderRoute } from './utils';

describe('Catalog editor (11.3, 18.3)', () => {
  it('walks the eight steps of the stepper', async () => {
    await renderRoute('/catalog/c-postgres');
    const nav = await screen.findByRole('navigation', { name: 'Catalog steps' });
    const labels = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent?.replace(/^\d+|done/g, '').trim());
    expect(labels).toEqual([
      'Source',
      'Configuration',
      'Authentication',
      'Network',
      'Overrides',
      'Security and limits',
      'Test',
      'Publish',
    ]);
  });

  it('11.3 Publish is enabled only after a passing test of this exact version', async () => {
    const { user } = await renderRoute('/catalog/c-postgres?step=test');
    expect(await screen.findByText('Passed as you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish v3.2.0' })).toBeEnabled();
    // Editing the entry makes the version untested until saved and re-run.
    await user.click(screen.getByRole('button', { name: /Source/ }));
    const name = await screen.findByLabelText(/Display name/);
    await user.type(name, '!');
    expect(screen.getByRole('button', { name: /Publish v/ })).toBeDisabled();
    expect(screen.getByText(/Save and test this version/)).toBeInTheDocument();
  });

  it('11.3 a new entry cannot publish and asks to save the draft to test it', async () => {
    await renderRoute('/catalog/new?step=test');
    expect(await screen.findByText(/Save the draft to run its test/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Publish v/ })).toBeDisabled();
  });

  it('11.3 shows start phases, discovered capabilities, guard scan and stderr', async () => {
    await renderRoute('/catalog/c-postgres?step=test');
    const phases = await screen.findByRole('list', { name: 'Start phases' });
    expect(
      within(phases)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['claim120 ms', 'bind80 ms', 'install2.3 s', 'spawn900 ms', 'connect310 ms']);
    expect(screen.getByText('Tool description scan')).toBeInTheDocument();
    expect(screen.getByText(/warn: DATABASE_URL uses a read-write role/)).toBeInTheDocument();
  });

  it('11.3 publishing a tested draft puts it in the Store', async () => {
    const { user } = await renderRoute('/catalog/c-postgres?step=publish');
    await user.click(await screen.findByRole('button', { name: 'Publish v3.2.0' }));
    await waitFor(() =>
      expect(getDb().catalog.find((c) => c.id === 'c-postgres')?.status).toBe('published'),
    );
  });

  it('11.5 shows the auto-install preview with an avatar strip', async () => {
    await renderRoute('/catalog/c-postgres');
    const card = await screen.findByRole('region', { name: 'Auto-install preview' });
    expect(await within(card).findByText(/people in 2 teams/)).toBeInTheDocument();
    expect(within(card).getByTestId('avatar-strip')).toBeInTheDocument();
  });

  it('10.1 members cannot open the editor', async () => {
    await renderRoute('/catalog/c-postgres', { role: 'member' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /Not in this role/ }),
    ).toBeInTheDocument();
  });
});

describe('Catalog list and policies', () => {
  it('lists entries with status and opens policies', async () => {
    const { user } = await renderRoute('/catalog');
    expect(await screen.findByText('Postgres analytics')).toBeInTheDocument();
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: 'Auto-install policies' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
  });

  it('11.5 previews who gets an auto-install policy before saving', async () => {
    const { user } = await renderRoute('/catalog?tab=policies');
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const dialog = await screen.findByRole('dialog', { name: /New auto-install policy/ });
    await user.click(within(dialog).getByRole('button', { name: 'Everyone' }));
    expect(await within(dialog).findByText(/451 people in/)).toBeInTheDocument();
  });
});

describe('Registry (11.6, 11.7)', () => {
  it('installs when allowed, requests when the policy says so, and shows blocked ones', async () => {
    const { user } = await renderRoute('/registry');
    expect(await screen.findByText('Blocked by registry policy')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Request install' })[0]!);
    await user.type(await screen.findByLabelText(/What do you need it for/), 'Payments');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(getDb().requests.some((r) => r.reason === 'Payments')).toBe(true));
  });

  it('10.1 managers approve install requests', async () => {
    const { user } = await renderRoute('/registry');
    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]!);
    await waitFor(() =>
      expect(getDb().requests.filter((r) => r.status === 'approved')).toHaveLength(1),
    );
  });

  it('10.1 auditors do not get the registry', async () => {
    await renderRoute('/registry', { role: 'auditor' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /Not in this role/ }),
    ).toBeInTheDocument();
  });
});

describe('Access (10, 18.3)', () => {
  it('10.4 the simulator highlights the deciding rule', async () => {
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: /Simulate/ }));
    expect(await screen.findByText('Denied')).toBeInTheDocument();
    const deciding = document.querySelector('[data-deciding]');
    expect(deciding?.textContent).toContain('rule-support-no-destructive');
  });

  it('shows policy rules as rows with a live affected count and locks org rules for managers', async () => {
    await renderRoute('/access', { role: 'manager' });
    expect(await screen.findByText('38 people · 6 tools')).toBeInTheDocument();
    expect(screen.getAllByText('Org rule · Admins edit').length).toBe(2);
    expect(screen.queryByRole('tab', { name: /IdP group mapping/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Custom Cedar policies/ })).toBeNull();
  });

  it('the rule builder counts affected people and tools live', async () => {
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: /New tool rule/ });
    await user.click(within(dialog).getByRole('button', { name: 'Everyone' }));
    await user.type(within(dialog).getByLabelText('Add a tool pattern'), 'delete_*{Enter}');
    await waitFor(() =>
      expect(dialog.querySelector('[aria-live=polite]')).toHaveTextContent(/38 people and 3 tools/),
    );
  });

  it('validates Cedar and keeps Save disabled while it has errors', async () => {
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: /Custom Cedar policies/ }));
    const editor = await screen.findByLabelText('Cedar policy');
    expect(await screen.findByText('The policy is valid.')).toBeInTheDocument();
    await user.clear(editor);
    await user.click(editor);
    await user.paste('permit (principal');
    expect(await screen.findByRole('alert', { name: 'Policy errors' })).toHaveTextContent(
      /Unbalanced parentheses/,
    );
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  });

  it('manages IdP group mapping rules (admin)', async () => {
    const { user } = await renderRoute('/access?tab=mapping');
    expect(await screen.findByText('bastion-admins')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete rule for bastion-admins' }));
    await waitFor(() =>
      expect(getDb().roleMapping.some((r) => r.idpGroup === 'bastion-admins')).toBe(false),
    );
  });
});

describe('Settings (19.2, 15.7)', () => {
  it('shows system status with replica tiles, queues and dependency checks', async () => {
    await renderRoute('/settings?section=system');
    expect(await screen.findByText('worker-6')).toBeInTheDocument();
    expect(screen.getByText(/1\.4\.1 · rolling out/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Guard model calls depth' })).toHaveAttribute(
      'aria-valuenow',
      '62',
    );
    expect(screen.getByText('Collector slow to respond')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Official MCP Registry sync history' }),
    ).toBeInTheDocument();
  });

  it('saves organization settings through zod validation', async () => {
    const { user } = await renderRoute('/settings');
    const name = await screen.findByLabelText(/Display name/);
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Save organization' }));
    expect(await screen.findByText(/at least 1 character|Too small/i)).toBeInTheDocument();
    await user.type(name, 'Acme Inc');
    await user.click(screen.getByRole('button', { name: 'Save organization' }));
    await waitFor(() => expect(getDb().settings.org.displayName).toBe('Acme Inc'));
  });

  it('tests an IdP connection and shows each step', async () => {
    const { user } = await renderRoute('/settings?section=idp');
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    const list = await screen.findByRole('list', { name: 'Connection test' });
    expect(within(list).getByText('Discovery document')).toBeInTheDocument();
  });
});

describe('Plugins (25, 18.3)', () => {
  it('shows per-client set up steps with status dots and the executable badge', async () => {
    await renderRoute('/plugins');
    expect(
      await screen.findByText('/plugin marketplace add https://bastion.acme.dev/plugins/acme.git'),
    ).toBeInTheDocument();
    expect(screen.getByText('One release behind')).toBeInTheDocument();
    expect(screen.getAllByText('Managed by IT').length).toBe(2);
    expect(screen.getAllByText('Runs code locally').length).toBeGreaterThan(0);
  });

  it('10.1 members see neither releases nor approvals nor the author button', async () => {
    await renderRoute('/plugins', { role: 'member' });
    await screen.findByText('Set up your clients');
    expect(screen.queryByText('Releases')).toBeNull();
    expect(screen.queryByText('Waiting for approval')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Author a plugin' })).toBeNull();
  });

  it('25.7 the marketplace page offers copy-ready rollout configuration per client', async () => {
    await renderRoute('/plugins/marketplace/mk-eng');
    await waitFor(() =>
      expect(screen.getByLabelText('Claude Code rollout')).toHaveTextContent(
        'extraKnownMarketplaces',
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Codex rollout')).toHaveTextContent(
        'restrict_to_allowed_sources',
      ),
    );
    expect(screen.getAllByRole('button', { name: /^Copy / }).length).toBeGreaterThan(3);
  });

  it('25.4 promotes the draft release and an admin approves executable content', async () => {
    const { user } = await renderRoute('/plugins');
    await user.click(await screen.findByRole('button', { name: 'Promote draft release' }));
    await waitFor(() =>
      expect(getDb().marketplaceDetails['mk-eng']?.releases.find((r) => r.n === 6)?.promoted).toBe(
        true,
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(
        getDb().versions['c-incident-kit']?.some((v) => v.executableApproval === 'approved'),
      ).toBe(true),
    );
  });

  it('25.3 the skill editor highlights executable files and previews SKILL.md live', async () => {
    const { user } = await renderRoute('/plugins/edit/c-incident-kit');
    expect((await screen.findAllByText('hooks/post-tool.sh')).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('note').some((n) => n.textContent?.includes('Executable content')),
    ).toBe(true);
    const desc = await screen.findByLabelText(/^Description\s\*/);
    await user.clear(desc);
    expect(await screen.findByText('Describe when to use this skill')).toBeInTheDocument();
    await user.type(
      await screen.findByLabelText('Instructions (Markdown)'),
      '{Control>}{End}{/Control}\n- Page the on-call',
    );
    expect(
      within(screen.getByLabelText('Live preview')).getByText('Page the on-call'),
    ).toBeInTheDocument();
  });

  it('a11y: Plugins has no axe violations', async () => {
    const { container } = await renderRoute('/plugins');
    await screen.findByText('Incident kit');
    expect(await expectNoA11yViolations(container)).toHaveNoViolations();
  });
});
