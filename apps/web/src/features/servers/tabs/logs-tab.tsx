import { Pause, Play, Trash2 } from 'lucide-react';
import * as React from 'react';
import { API_BASE } from '@/api/client';
import { useEventLines } from '@/api/events';
import type { InstallationView } from '@/api/views/servers';
import { EmptyState } from '@/components/empty-state';
import { StatusDot } from '@/components/status';
import { Button } from '@/components/ui/button';

const MAX_LINES = 500;

/** The text of one `log` event: `{"line":"..."}`, or the raw data when it is not JSON. */
export const parseLogLine = (data: string): string => {
  try {
    const v: unknown = JSON.parse(data);
    if (v && typeof v === 'object' && 'line' in v && typeof v.line === 'string') return v.line;
  } catch {
    // not JSON: show it as it is
  }
  return data;
};

/** Live stderr tail (SSE) for sandboxed servers. */
export function LogsTab({ installation: i }: { installation: InstallationView }) {
  const sandboxed = i.sandboxed;
  const [lines, setLines] = React.useState<string[]>([]);
  const [paused, setPaused] = React.useState(false);
  const ref = React.useRef<HTMLPreElement>(null);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  // Every `log` event of the stream carries `{ line }` as JSON (routes/installations.ts).
  useEventLines(sandboxed ? `${API_BASE}/installations/${i.id}/logs` : null, (data) => {
    if (pausedRef.current) return;
    const line = parseLogLine(data);
    setLines((l) => [...l.slice(-(MAX_LINES - 1)), line]);
  });
  React.useEffect(() => {
    if (!paused && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [paused]);

  if (!sandboxed) {
    return (
      <EmptyState
        title="Remote servers have no log"
        description="Logs exist for servers Bastion runs in a sandbox. For a remote server, check its activity instead."
        action={{ label: 'See activity', to: `/servers/${i.id}`, search: { tab: 'activity' } }}
      />
    );
  }
  return (
    <section
      aria-label="Server output"
      className="flex flex-col gap-3 rounded-lg bg-[#171a3a] p-5 text-[#f4f4f6]"
    >
      <div className="flex items-center gap-3">
        <span className="flex-1 text-overline !text-[#a7a9b8]">stderr</span>
        <StatusDot
          tone={paused ? 'neutral' : 'ok'}
          label={paused ? 'Paused' : 'Live'}
          className="!text-[#f4f4f6]"
        />
        <Button
          variant="ghost"
          size="xs"
          className="bg-[#2e2e36] text-[#f4f4f6] hover:bg-[#2e2e36] hover:text-[#f4f4f6]"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
        >
          {paused ? (
            <Play className="size-4" aria-hidden="true" />
          ) : (
            <Pause className="size-4" aria-hidden="true" />
          )}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="bg-[#2e2e36] text-[#f4f4f6] hover:bg-[#2e2e36] hover:text-[#f4f4f6]"
          onClick={() => setLines([])}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Clear
        </Button>
      </div>
      <pre
        ref={ref}
        role="log"
        aria-live="off"
        aria-label="Live server output"
        className="m-0 h-80 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-5"
      >
        {lines.length === 0 ? 'Waiting for output…' : lines.join('\n')}
      </pre>
    </section>
  );
}
