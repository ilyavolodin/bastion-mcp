import * as React from 'react';
import { useClientConfig } from '@/api/hooks';
import type { ClientKind } from '@/api/views/servers';
import { cn } from '@/lib/cn';
import { CopyField } from './copy-field';
import { ProblemAlert } from './problem';
import { Skeleton } from './ui/skeleton';

export const CLIENTS: { id: ClientKind; name: string; badge: string }[] = [
  { id: 'claude-desktop', name: 'Claude Desktop', badge: 'C' },
  { id: 'claude-code', name: 'Claude Code', badge: '>_' },
  { id: 'cursor', name: 'Cursor', badge: 'Cu' },
  { id: 'vscode', name: 'VS Code', badge: 'VS' },
];

/**
 * Copy-ready configuration for one client of one endpoint (Home, Install ready screen, Endpoints). Without an
 * `endpointId` it is the default endpoint's.
 */
export function ClientConfigPanel({
  endpointId,
  client,
}: {
  endpointId?: string | undefined;
  client: ClientKind;
}) {
  const q = useClientConfig(endpointId, client);
  const label = CLIENTS.find((c) => c.id === client)?.name ?? client;
  if (q.isPending) return <Skeleton className="h-28 w-full" />;
  if (q.isError) return <ProblemAlert error={q.error} onRetry={() => void q.refetch()} />;
  const cfg = q.data;
  const json = cfg.config ? JSON.stringify(cfg.config, null, 2) : null;
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-muted">
        {cfg.instructions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {cfg.file ? <span className="font-mono text-caption text-muted">{cfg.file}</span> : null}
      {cfg.command ? (
        <CopyField value={cfg.command} label={`${label} command`} tone="dark" mono />
      ) : null}
      {json ? (
        <div className="relative">
          <pre className="m-0 overflow-x-auto rounded-md bg-[#171a3a] p-3.5 font-mono text-[12px] leading-[20px] text-[#f4f4f6]">
            {json}
          </pre>
          <div className="mt-2">
            <CopyField
              value={json}
              label={`${label} configuration`}
              tone="sunken"
              buttonLabel="Copy config"
              className="[&>span:first-child]:text-[13px]"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Client chooser (radio-like pills) plus the panel for the chosen client. */
export function ClientConfigTabs({
  endpointId,
  initial = 'claude-desktop',
}: {
  endpointId?: string | undefined;
  initial?: ClientKind;
}) {
  const [client, setClient] = React.useState<ClientKind>(initial);
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Client" className="flex flex-wrap gap-2">
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={client === c.id}
            onClick={() => setClient(c.id)}
            className={cn(
              'inline-flex h-10 items-center gap-2 rounded-md px-3 text-[13px] font-medium',
              client === c.id ? 'bg-tangerine-soft text-tangerine-ink' : 'bg-sunken text-ink',
            )}
          >
            <span className="inline-flex size-[22px] items-center justify-center rounded-full bg-surface text-[11px] font-semibold">
              {c.badge}
            </span>
            {c.name}
          </button>
        ))}
      </div>
      <ClientConfigPanel endpointId={endpointId} client={client} />
    </div>
  );
}
