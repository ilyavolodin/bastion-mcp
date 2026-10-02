import * as React from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './ui/skeleton';

export type CodeEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  language: 'json' | 'cedar';
  ariaLabel: string;
  height?: number;
  readOnly?: boolean;
  /** JSON Schema used by Monaco's JSON language service for inline validation. */
  jsonSchema?: Record<string, unknown>;
  /** Extra markers (line is 1-based), e.g. server-side Cedar validation errors. */
  markers?: { line: number; message: string }[];
};

// Monaco is large: it is only fetched when an editor is first shown.
const MonacoImpl = React.lazy(() => import('./monaco-impl'));

/** Textarea used while Monaco loads, when it fails to load, and as the accessible fallback. */
export function PlainEditor({ value, onChange, ariaLabel, height = 320, readOnly, className }: CodeEditorProps & { className?: string }) {
  return (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(e) => onChange?.(e.target.value)}
      style={{ height }}
      className={cn('w-full rounded-md border border-line-strong bg-surface p-3 font-mono text-[13px] leading-5 text-ink', className)}
    />
  );
}

class EditorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Monaco for JSON (overrides, definitions) and Cedar (custom policies), lazy loaded. */
export function CodeEditor(props: CodeEditorProps) {
  const fallback = <PlainEditor {...props} />;
  return (
    <div className="overflow-hidden rounded-md border border-line-strong" data-testid={`code-editor-${props.language}`}>
      <EditorBoundary fallback={fallback}>
        <React.Suspense fallback={<Skeleton className="w-full rounded-none" style={{ height: props.height ?? 320 }} />}>
          <MonacoImpl {...props} />
        </React.Suspense>
      </EditorBoundary>
    </div>
  );
}
