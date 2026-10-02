import { CircleAlert, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';
import * as React from 'react';
import { ApiError } from '@/api/client';
import { Button } from './ui/button';

type Action = { label: string; href?: string; onClick?: () => void };

const describe = (error: unknown): { title: string; detail: string; Icon: typeof CircleAlert; fields: string[] } => {
  if (error instanceof ApiError) {
    const fields = error.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
    if (error.status === 0) return { title: error.title, detail: 'Check your connection and try again.', Icon: WifiOff, fields };
    if (error.status === 403) return { title: error.title, detail: error.detail || 'Ask an admin if you need this.', Icon: ShieldOff, fields };
    if (error.status === 412) return { title: 'Changed by someone else', detail: 'Reload to see the latest version, then try again.', Icon: RefreshCw, fields };
    return { title: error.title, detail: error.detail, Icon: CircleAlert, fields };
  }
  return {
    title: 'Something went wrong',
    detail: error instanceof Error ? error.message : '',
    Icon: CircleAlert,
    fields: [],
  };
};

/** Inline problem+json display with the one next action (retry). */
export function ProblemAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { title, detail, Icon, fields } = describe(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg bg-coral-soft p-4 text-ink">
      <Icon className="mt-0.5 size-5 shrink-0 text-coral-ink" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-semibold text-coral-ink">{title}</p>
        {detail ? <p className="m-0 text-[13px]">{detail}</p> : null}
        {fields.length ? (
          <ul className="m-0 mt-1 list-disc pl-5 text-[13px]">
            {fields.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A full-page problem (bootstrap failures, route crashes). */
export function ProblemScreen({
  error,
  title,
  onRetry,
  action,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  action?: Action | undefined;
}) {
  const d = describe(error);
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <d.Icon className="size-10 text-muted" aria-hidden="true" />
        <h1 className="m-0 text-[22px] leading-[30px] font-semibold">{title ?? d.title}</h1>
        {d.detail ? <p className="m-0 text-muted">{d.detail}</p> : null}
        {action?.href ? (
          <Button asChild>
            <a href={action.href}>{action.label}</a>
          </Button>
        ) : onRetry ? (
          <Button onClick={onRetry}>Try again</Button>
        ) : null}
      </div>
    </main>
  );
}

type BoundaryProps = { children: React.ReactNode; fallback?: (e: unknown, reset: () => void) => React.ReactNode };

/** Route-level error boundary: a crash in one screen keeps the shell alive. */
export class ErrorBoundary extends React.Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  reset = () => this.setState({ error: null });
  override render() {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return (
      <div className="mx-auto my-16 max-w-xl">
        <ProblemAlert error={this.state.error} onRetry={this.reset} />
      </div>
    );
  }
}
