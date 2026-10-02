import { useState } from 'react';
import { useEndpoints } from '@/api/hooks';
import type { ClientId } from '@/api/types';
import { CLIENTS, ClientConfigPanel } from '@/components/client-config';
import { CopyField } from '@/components/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

function NetworkArt() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      stroke="#171a3a"
      strokeWidth="1.5"
      aria-hidden="true"
      className="shrink-0 opacity-85 max-sm:hidden"
    >
      <circle cx="12" cy="32" r="6" />
      <circle cx="52" cy="14" r="5" />
      <circle cx="52" cy="32" r="5" />
      <circle cx="52" cy="50" r="5" />
      <path d="M18 32h10M28 32 47 14M28 32h19M28 32l19 18" />
    </svg>
  );
}

/** "Connect your AI tools": the endpoint URL, a copy button and one-click config per client (18.3). */
export function ConnectCard() {
  const endpoints = useEndpoints();
  const [client, setClient] = useState<ClientId | null>(null);
  const endpoint = endpoints.data?.find((e) => e.isDefault) ?? endpoints.data?.[0];
  const current = CLIENTS.find((c) => c.id === client);
  return (
    <section
      aria-label="Connect your AI tools"
      className="relative flex min-w-0 flex-[2_1_560px] flex-col gap-4 overflow-hidden rounded-xl bg-grad-sunset p-6 text-[#171a3a]"
    >
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h2 className="m-0 text-[22px] leading-[30px] font-semibold">Connect your AI tools</h2>
          <p className="m-0 mt-1 max-w-[520px]">
            One URL carries every server you’ve installed. Sign in once from your client; Bastion handles
            each server’s credentials.
          </p>
        </div>
        <NetworkArt />
      </div>
      {endpoint ? (
        <CopyField value={endpoint.url} label="endpoint URL" />
      ) : endpoints.isPending ? (
        <Skeleton className="h-[52px] bg-white/60" />
      ) : (
        <p className="m-0 rounded-md bg-white/70 p-3">
          No endpoint yet. Install a server and your default endpoint appears here.
        </p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="One-click client setup">
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={!endpoint}
            onClick={() => setClient(c.id)}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-white/70 px-3.5 text-label text-[#171a3a] hover:bg-white/90 disabled:opacity-60"
          >
            <span className="inline-flex size-[22px] items-center justify-center rounded-full bg-white text-[11px] font-semibold">
              {c.badge}
            </span>
            {c.name}
          </button>
        ))}
      </div>
      <p className="m-0 text-caption">
        Need only a few servers in one client? Create a named endpoint in My servers.
      </p>
      <Dialog open={client !== null} onOpenChange={(o) => !o && setClient(null)}>
        <DialogContent
          title={`Add Bastion to ${current?.name ?? ''}`}
          description="Copy this into your client, then sign in once."
        >
          {client ? <ClientConfigPanel endpointId={endpoint?.id} client={client} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
