import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UiRole } from '@/api/types';
import { canSee, NAV_ORDER, type NavSection, SECTIONS } from '@/lib/roles';
import { expectNoA11yViolations, renderRoute } from './utils';

const ROLES: UiRole[] = ['admin', 'manager', 'member', 'auditor'];
const TITLE: Record<NavSection, RegExp> = {
  home: /^Home$/,
  store: /^Store$/,
  servers: /^My servers$/,
  activity: /^Activity$/,
  plugins: /^Plugins$/,
  observability: /^Observability$/,
  security: /^Security$/,
  catalog: /^Catalog$/,
  registry: /^Registry$/,
  access: /^Access$/,
  settings: /^Settings$/,
};

describe('app shell', () => {
  it('18.2 the sidebar lists exactly the sections of the signed-in role', async () => {
    for (const role of ROLES) {
      const { unmount } = await renderRoute('/', { role });
      const nav = screen.getByRole('navigation', { name: 'Main' });
      const labels = within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('title'));
      const expected = NAV_ORDER.filter((s) =>
        canSee(s, role, { registry: role !== 'auditor' }),
      ).map((s) => SECTIONS[s].label);
      expect(labels).toEqual(expected);
      unmount();
    }
  });

  for (const role of ROLES) {
    it(`18.2 role gating per screen as ${role}`, async () => {
      for (const section of NAV_ORDER) {
        const { unmount } = await renderRoute(SECTIONS[section].path, { role });
        if (canSee(section, role, { registry: role !== 'auditor' })) {
          expect(
            await screen.findByRole('heading', { level: 1, name: TITLE[section] }),
          ).toBeInTheDocument();
        } else {
          const h = await screen.findByRole('heading', { level: 1 });
          expect(h.textContent).toMatch(/Not in this role|Only Admins see Settings/);
        }
        unmount();
      }
    }, 60_000);
  }

  it('18.2 settings shows its own message for non-admins', async () => {
    await renderRoute('/settings', { role: 'manager' });
    expect(
      await screen.findByRole('heading', { name: 'Only Admins see Settings' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toBeInTheDocument();
  });

  it('18.1 light is the default and dark is opt-in from the user menu', async () => {
    const { user } = await renderRoute('/');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: /Account menu for Dana/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Dark theme/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('18.1 the role preview bar is off unless ?rolePreview=1', async () => {
    await renderRoute('/');
    expect(screen.queryByRole('region', { name: 'Role preview' })).toBeNull();
  });

  it('18.2 Ctrl+K opens the command palette that finds tools and pages', async () => {
    const { user } = await renderRoute('/');
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search servers, tools, people and settings/);
    await user.type(input, 'pg_describe');
    expect(await screen.findByText('pg_describe_table')).toBeInTheDocument();
  });

  it('18.1 the bell shows unread notifications and lists them', async () => {
    const { user } = await renderRoute('/');
    const bell = await screen.findByRole('button', { name: /Notifications, 2 unread/ });
    await user.click(bell);
    expect(await screen.findByText('GitHub isn’t connected yet')).toBeInTheDocument();
  });

  it('shows the not-found screen with one next action', async () => {
    await renderRoute('/nope');
    expect(
      await screen.findByRole('heading', { name: 'That page does not exist' }),
    ).toBeInTheDocument();
  });

  it('a11y: Home has no axe violations', async () => {
    const { container } = await renderRoute('/');
    await screen.findByText('Connect your AI tools');
    await screen.findByText('Postgres analytics');
    expect(await expectNoA11yViolations(container)).toHaveNoViolations();
  });
});
