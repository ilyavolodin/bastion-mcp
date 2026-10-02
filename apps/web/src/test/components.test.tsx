import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { ChartCard } from '@/components/chart-card';
import { CopyField } from '@/components/copy-field';
import { DiffView } from '@/components/diff-view';
import { ErrorBoundary, ProblemAlert } from '@/components/problem';
import { Sparkline } from '@/components/sparkline';
import { OutcomeBadge, StatusDot } from '@/components/status';
import { Stepper } from '@/components/stepper';
import { cn } from '@/lib/cn';

describe('StatusDot (18.1)', () => {
  it('never relies on colour alone: dot, icon and text label', () => {
    const { container } = render(<StatusDot tone="bad" label="Not starting" />);
    expect(screen.getByText('Not starting')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });
  it('outcome badges carry a text label', () => {
    render(<OutcomeBadge outcome="blocked" />);
    expect(screen.getByText('Blocked by guard')).toBeInTheDocument();
  });
});

describe('ChartCard (18.1 view as table)', () => {
  it('toggles between the chart and an accessible table', async () => {
    const user = userEvent.setup();
    render(
      <ChartCard
        title="Calls"
        table={{
          columns: ['Day', 'Calls'],
          rows: [
            ['Mon', 3],
            ['Tue', 5],
          ],
        }}
      >
        <svg data-testid="chart" />
      </ChartCard>,
    );
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    const table = screen.getByRole('table', { name: 'Calls' });
    expect(table).toHaveTextContent('Tue');
    expect(screen.getByRole('rowheader', { name: 'Mon' })).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).toBeNull();
  });
});

describe('Stepper', () => {
  it('marks done steps, the current step and reports selection', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <Stepper
        steps={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ]}
        current="b"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('button', { name: /B/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /A/ })).toHaveTextContent('done');
    await user.click(screen.getByRole('button', { name: /C/ }));
    expect(onSelect).toHaveBeenCalledWith('c');
  });
});

describe('CopyField', () => {
  it('copies and announces', async () => {
    const user = userEvent.setup();
    render(<CopyField value="https://x/mcp" label="endpoint URL" />);
    await user.click(screen.getByRole('button', { name: 'Copy endpoint URL' }));
    expect(await screen.findByText('endpoint URL copied')).toBeInTheDocument();
  });
});

describe('DiffView', () => {
  it('highlights removed and added words on their own sides', () => {
    render(
      <DiffView
        leftLabel="Old"
        rightLabel="New"
        left="fetch the event"
        right="fetch the event and post it"
      />,
    );
    expect(document.querySelector('mark[data-diff="added"]')?.textContent).toContain('and post it');
    expect(document.querySelector('mark[data-diff="removed"]')).toBeNull();
  });
  it('renders a side-by-side line diff', () => {
    render(
      <DiffView mode="lines" leftLabel="Up" rightLabel="Final" left={'a\nb'} right={'a\nc'} />,
    );
    expect(document.querySelectorAll('[data-diff="removed"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-diff="added"]')).toHaveLength(1);
  });
});

describe('Sparkline', () => {
  it('is labelled for assistive tech and hidden without data', () => {
    const { rerender } = render(<Sparkline data={[1, 2, 3]} label="Calls" />);
    expect(screen.getByRole('img', { name: 'Calls' })).toBeInTheDocument();
    rerender(<Sparkline data={[1]} label="Calls" />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('errors (17.1)', () => {
  it('shows problem+json title, detail, field errors and a retry', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(
      <ProblemAlert
        error={
          new ApiError({
            status: 422,
            title: 'Invalid',
            detail: 'Fix it',
            errors: [{ path: 'name', message: 'Required' }],
          })
        }
        onRetry={retry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid');
    expect(screen.getByText('name: Required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
  it('an error boundary keeps a crash local and offers a retry', () => {
    const Boom = () => {
      throw new Error('kaboom');
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom');
  });
});

describe('cn', () => {
  it('keeps custom type utilities next to colour utilities', () => {
    expect(cn('text-label', 'text-coral-ink')).toBe('text-label text-coral-ink');
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});
