import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyServerEvent, openEventStream } from '@/api/events';
import { getDb } from '@/mocks/db';
import { DAY } from '@/mocks/util';
import { expectNoA11yViolations, renderRoute } from './utils';

/** Share of the last 24 hours' calls of one server that did not succeed, as the health tile computes it. */
const errorRateOf = (installationId: string): string => {
  const since = getDb().now - DAY;
  const calls = getDb().data.observability.calls.filter(
    (c) => c.installationId === installationId && new Date(c.ts).getTime() >= since,
  );
  const failed = calls.filter((c) => c.outcome !== 'ok' && c.outcome !== 'input_required');
  return `${((failed.length / calls.length) * 100).toFixed(1)}%`;
};

describe('Observability (15, 18.3)', () => {
  it('renders five panels, each with an accessible table toggle', async () => {
    const { user } = await renderRoute('/observability');
    for (const name of [
      'Where calls go',
      'Server health',
      'Busiest people',
      'Latency',
      'Sandboxes',
    ]) {
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
    }
    const toggles = screen.getAllByRole('button', { name: 'View as table' });
    expect(toggles).toHaveLength(5);
    await user.click(toggles[1]!);
    const table = await screen.findByRole('table', { name: 'Server health' });
    expect(within(table).getByText('Postgres analytics')).toBeInTheDocument();
    expect(within(table).getByText(errorRateOf('i-postgres'))).toBeInTheDocument();
  });

  it('15.5 latency draws p50, p95 and p99 as lines of their own, and no value is NaN', async () => {
    const { user } = await renderRoute('/observability');
    const heading = await screen.findByRole('heading', { name: 'Latency' });
    const card = heading.closest('section') ?? heading.parentElement?.parentElement;
    expect(card).toBeTruthy();
    const panel = within(card as HTMLElement);
    // The legend names all three percentiles (before: a p50 line and a band that the tooltip printed as NaN).
    expect(panel.getByText('Typical (p50)')).toBeVisible();
    expect(panel.getByText('Slow (p95)')).toBeVisible();
    expect(panel.getByText('Slowest (p99)')).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'View as table' }));
    const table = await panel.findByRole('table', { name: 'Latency' });
    expect(within(table).getByRole('columnheader', { name: 'p99 (ms)' })).toBeVisible();
    expect((card as HTMLElement).textContent).not.toContain('NaN');
  });

  /** Calls of the last 24 hours per person, as the mock call log has them. */
  const callsByPerson = () => {
    const since = getDb().now - DAY;
    const by = new Map<string, number>();
    for (const c of getDb().data.observability.calls) {
      if (new Date(c.ts).getTime() < since) continue;
      by.set(c.principalId, (by.get(c.principalId) ?? 0) + 1);
    }
    return by;
  };

  it('15.5 an Admin sees the busiest people, ranked, each linking to their traffic and their calls', async () => {
    const { user } = await renderRoute('/observability');
    const heading = await screen.findByRole('heading', { name: 'Busiest people' });
    const card = heading.closest('section') as HTMLElement;
    const [topId, topCalls] = [...callsByPerson().entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    expect(topId).toBeTruthy();
    const name = getDb().data.access.users.find((u) => u.id === topId)?.displayName ?? '';
    expect(await within(card).findByRole('link', { name })).toHaveAttribute(
      'href',
      expect.stringContaining(`person=${topId}`),
    );
    expect(within(card).getByRole('link', { name: `Calls of ${name}` })).toHaveAttribute(
      'href',
      expect.stringContaining(`user=${topId}`),
    );
    await user.click(within(card).getByRole('button', { name: 'View as table' }));
    const table = await within(card).findByRole('table', { name: 'Busiest people' });
    const firstRow = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(firstRow).toHaveTextContent(name);
    expect(firstRow).toHaveTextContent(String(topCalls));
  });

  it('15.5 the person scope shows one person’s traffic only', async () => {
    const personId = 'u-raj';
    const { user } = await renderRoute(`/observability?scope=person&person=${personId}`);
    expect(await screen.findByText('Traffic of Raj Mehta.')).toBeInTheDocument();
    // Their numbers are the whole traffic panel; the people ranking is for everybody and is not shown.
    expect(screen.queryByRole('heading', { name: 'Busiest people' })).toBeNull();
    const traffic = (await screen.findByRole('heading', { name: 'Where calls go' })).closest(
      'section',
    ) as HTMLElement;
    await user.click(within(traffic).getByRole('button', { name: 'View as table' }));
    const table = await within(traffic).findByRole('table', { name: 'Where calls go' });
    const rows = within(table).getAllByRole('row').slice(1);
    const sum = rows.reduce(
      (n, r) => n + Number(r.children[1]?.textContent?.replaceAll(',', '')),
      0,
    );
    expect(sum).toBe(callsByPerson().get(personId));
  });

  it('10.1 only Admins and Auditors can pick a person: managers see their team', async () => {
    await renderRoute('/observability', { role: 'manager' });
    await screen.findByRole('heading', { name: 'Latency' });
    expect(screen.queryByRole('button', { name: 'A person' })).toBeNull();
  });

  it('colours health tiles and pairs them with a text label', async () => {
    await renderRoute('/observability');
    expect((await screen.findAllByText('Failing')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0);
  });

  it('15.5 ranks servers by calls from the rollups, named by installation', async () => {
    const { user } = await renderRoute('/observability');
    await screen.findByRole('heading', { name: 'Where calls go' });
    await user.click(screen.getAllByRole('button', { name: 'View as table' })[0]!);
    const table = await screen.findByRole('table', { name: 'Where calls go' });
    expect(within(table).getByText('GitHub')).toBeInTheDocument();
    expect(within(table).getByText('Postgres analytics')).toBeInTheDocument();
  });

  it('10.1 managers see their team scope only', async () => {
    await renderRoute('/observability', { role: 'manager' });
    await screen.findByRole('heading', { name: 'Latency' });
    expect(screen.queryByRole('button', { name: 'Whole org' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Platform team' })).toBeInTheDocument();
  });

  it('a11y: Observability has no axe violations', async () => {
    const { container } = await renderRoute('/observability');
    await screen.findByRole('heading', { name: 'Latency' });
    await waitFor(() => expect(container.querySelector('[aria-busy=true]')).toBeNull());
    const r = await expectNoA11yViolations(container);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
  });
});

describe('Security (13.6)', () => {
  it('shows the changed definition with the guard verdict that flagged it', async () => {
    await renderRoute('/security');
    expect(await screen.findByText('Changed tool definitions')).toBeInTheDocument();
    const view = await screen.findByTestId('definition-view');
    expect(within(view).getAllByText(/slack_post_message/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/tool-poisoning-judge flagged this definition as malicious/),
    ).toBeInTheDocument();
  });

  it('a malicious scan blocks accepting; keeping the block asks for a reason and rejects the review', async () => {
    const { user } = await renderRoute('/security');
    expect(await screen.findByRole('button', { name: 'Accept new definition' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Keep blocking get_event/ }));
    const dialog = await screen.findByRole('dialog', { name: /Keep blocking get_event/ });
    await user.type(within(dialog).getByLabelText(/Reason/), 'It tells the model to mirror events');
    await user.click(within(dialog).getByRole('button', { name: 'Keep blocking' }));
    await waitFor(() =>
      expect(getDb().data.observability.drift.find((d) => d.id === 'dr-1')?.status).toBe(
        'rejected',
      ),
    );
    expect(getDb().data.observability.drift.find((d) => d.id === 'dr-1')?.reason).toBe(
      'It tells the model to mirror events',
    );
  });

  it('10.1 auditors get a read-only note instead of decision buttons', async () => {
    await renderRoute('/security', { role: 'auditor' });
    expect(await screen.findByText(/Read-only\. A Manager of the owning team/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept new definition' })).toBeNull();
  });

  it('13.6 lists guard blocks, changed definitions and denied network access as findings', async () => {
    await renderRoute('/security');
    const card = await screen.findByRole('region', { name: 'Recent findings' }).catch(() => null);
    const scope = card ?? document.body;
    expect((await within(scope).findAllByText('Blocked by a guard')).length).toBeGreaterThan(0);
    expect(within(scope).getAllByText('Definition changed').length).toBeGreaterThan(0);
    expect(within(scope).getByText('telemetry.example.net:443')).toBeInTheDocument();
  });
});

describe('live updates (18.1)', () => {
  class FakeSource {
    listeners = new Map<string, ((e: Event) => void)[]>();
    closed = false;
    addEventListener(t: string, l: (e: Event) => void) {
      this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
    }
    removeEventListener(t: string, l: (e: Event) => void) {
      this.listeners.set(
        t,
        (this.listeners.get(t) ?? []).filter((x) => x !== l),
      );
    }
    close() {
      this.closed = true;
    }
    emit(t: string, data: unknown) {
      for (const l of this.listeners.get(t) ?? [])
        l(new MessageEvent(t, { data: JSON.stringify(data) }));
    }
  }

  it('parses typed SSE events and closes the stream', () => {
    const src = new FakeSource();
    const seen: unknown[] = [];
    const stop = openEventStream(
      (e) => seen.push(e),
      () => src as unknown as EventSource,
    );
    src.emit('installation.status', { id: 'i1', status: 'ready' });
    src.emit('notification', 'not-json-object');
    expect(seen[0]).toEqual({ type: 'installation.status', data: { id: 'i1', status: 'ready' } });
    stop();
    expect(src.closed).toBe(true);
  });

  it('invalidates the right queries and returns a notification to toast', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const n = applyServerEvent(qc, {
      type: 'notification',
      data: {
        id: '1',
        userId: 'u-dana',
        type: 'drift',
        title: 'T',
        data: { message: 'B' },
        createdAt: '',
        updatedAt: '',
        readAt: null,
      },
    });
    expect(n?.title).toBe('T');
    expect(n?.body).toBe('B');
    expect(n?.href).toBe('/security');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['notifications'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['drift-reviews'] });
    expect(
      applyServerEvent(qc, {
        type: 'installation.status',
        data: { installationId: 'i', status: 'ready' },
      }),
    ).toBeNull();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['installations'] });
  });
});
