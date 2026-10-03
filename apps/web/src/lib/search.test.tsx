import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useSearchState } from './search';

const schema = z.object({
  tab: z.enum(['a', 'b']).catch('a').default('a'),
  q: z.coerce.string().optional(),
});

type Controls = { set?: ReturnType<typeof useSearchState<typeof schema>>[1] };

const mount = async (url: string) => {
  const controls: Controls = {};
  function Screen() {
    const [value, set] = useSearchState(schema);
    const search = useRouterState({ select: (s) => s.location.searchStr });
    controls.set = set;
    return (
      <>
        <output aria-label="value">{JSON.stringify(value)}</output>
        <output aria-label="url">{search}</output>
      </>
    );
  }
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/', component: Screen });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByLabelText('value');
  return controls;
};

const value = () => JSON.parse(screen.getByLabelText('value').textContent ?? '{}');

describe('useSearchState', () => {
  it('reads the query through the schema', async () => {
    await mount('/?tab=b&q=hello');
    expect(value()).toEqual({ tab: 'b', q: 'hello' });
  });

  it('falls back to the defaults when the URL was edited by hand into something invalid', async () => {
    await mount('/?tab=zzz');
    expect(value()).toEqual({ tab: 'a' });
  });

  it('writes a patch into the URL and keeps the other keys', async () => {
    const controls = await mount('/?tab=b');
    await act(async () => controls.set?.({ q: 'pg' }));
    await waitFor(() => expect(value()).toEqual({ tab: 'b', q: 'pg' }));
    expect(screen.getByLabelText('url').textContent).toContain('q=pg');
  });

  it('drops a key that is set to undefined or empty, so URLs stay short', async () => {
    const controls = await mount('/?tab=b&q=pg');
    await act(async () => controls.set?.({ q: undefined }));
    await waitFor(() => expect(value()).toEqual({ tab: 'b' }));
    expect(screen.getByLabelText('url').textContent).not.toContain('q=');
    await act(async () => controls.set?.({ tab: 'a', q: '' }));
    await waitFor(() => expect(screen.getByLabelText('url').textContent).not.toContain('q='));
  });
});
