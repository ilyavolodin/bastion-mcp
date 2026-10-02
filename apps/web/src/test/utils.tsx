import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type * as React from 'react';
import type { UiRole } from '@/api/types';
import { AuthProvider } from '@/auth/auth';
import { type MockDb, resetDb } from '@/mocks/db';
import { createAppRouter } from '@/router';

export const testQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

/** Renders the whole app (auth, router, shell) at a path against the MSW fixtures for a role. */
export async function renderRoute(
  path = '/',
  opts: { role?: UiRole; prepare?: (db: MockDb) => void } = {},
) {
  const db = resetDb(opts.role ?? 'admin');
  opts.prepare?.(db);
  const qc = testQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(qc, history);
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: 'Main', hidden: true });
  return { ...utils, router, qc, user };
}

/** Renders one component with a query client only (no router). */
export function renderWithClient(ui: React.ReactElement) {
  const qc = testQueryClient();
  const user = userEvent.setup();
  return { ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>), qc, user };
}

export const expectNoA11yViolations = async (container: HTMLElement) => {
  const results = await axe(container, {
    rules: {
      // jsdom has no layout, so colour contrast cannot be computed; Playwright checks it in a browser.
      'color-contrast': { enabled: false },
      region: { enabled: false },
    },
  });
  return results;
};
