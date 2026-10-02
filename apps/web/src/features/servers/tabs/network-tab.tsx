import { Ban, Globe, ShieldCheck } from 'lucide-react';
import { useEgress } from '@/api/hooks';
import type { Installation } from '@/api/types';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { cn } from '@/lib/cn';

/**
 * Allowed and denied egress hosts as chips with a badge (18.3, 8.8). The API has no access-request route
 * (17.2): admins extend a server's allowlist from its catalog entry or an override.
 */
export function NetworkTab({ installation: i }: { installation: Installation }) {
  const q = useEgress(i.id);
  return (
    <QueryBoundary query={q}>
      {(hosts) => (
        <div className="flex flex-col gap-6">
          <Card aria-label="Egress hosts" className="gap-4">
            <CardHeader title="Where this server can connect" />
            {hosts.length === 0 ? (
              <p className="m-0 text-muted">
                This server has not tried to reach anything outside Bastion.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {hosts.map((h) => (
                  <li
                    key={h.host}
                    title={h.reason}
                    className={cn(
                      'inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] font-medium',
                      h.status === 'allowed' ? 'bg-sunken' : 'bg-coral-soft text-coral-ink',
                    )}
                  >
                    <Globe className="size-3.5" aria-hidden="true" />
                    {h.host}
                    <Tag
                      tone={h.status === 'allowed' ? 'ok' : 'bad'}
                      icon={
                        h.status === 'allowed' ? (
                          <ShieldCheck className="size-3" aria-hidden="true" />
                        ) : (
                          <Ban className="size-3" aria-hidden="true" />
                        )
                      }
                    >
                      {h.status === 'allowed' ? 'Allowed' : 'Denied'}
                    </Tag>
                  </li>
                ))}
              </ul>
            )}
            {hosts.some((h) => h.status === 'denied') ? (
              <p className="m-0 text-caption text-muted">
                To allow a denied host, ask an admin to add it to this server's egress allowlist.
              </p>
            ) : null}
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}
