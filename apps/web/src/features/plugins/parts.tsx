import { Link } from '@tanstack/react-router';
import { Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { useApproveExecutable, useExecutableApprovals, useMarketplace, usePromoteRelease, usePushMirror } from '@/api/hooks';
import type { MarketplaceDetail, MarketplacePlugin, PluginClientStatus } from '@/api/types';
import { CopyField } from '@/components/copy-field';
import { Card, CardHeader, ServerIcon, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusDot, type Tone } from '@/components/status';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

const CLIENT_STATUS: Record<PluginClientStatus['status'], { tone: Tone; label: string }> = {
  latest: { tone: 'ok', label: 'Latest' },
  behind: { tone: 'warn', label: 'One release behind' },
  managed: { tone: 'info', label: 'Managed by IT' },
  unknown: { tone: 'neutral', label: 'Not fetched yet' },
};

const BADGE: Record<string, string> = { 'claude-code': '>_', codex: 'Cx', 'claude-desktop': 'C', chatgpt: 'GP' };

/** Set up panel for one client: exact steps, and a status dot for whether this machine has the latest release. */
export function ClientSetupCard({ c }: { c: PluginClientStatus }) {
  const s = CLIENT_STATUS[c.status];
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-sunken text-[11px] font-semibold">{BADGE[c.client] ?? c.label.charAt(0)}</span>
        <span className="flex-1 text-[14px] font-semibold">{c.label}</span>
        <StatusDot tone={s.tone} label={s.label} className="font-semibold" />
      </div>
      {c.command ? <CopyField value={c.command} label={`${c.label} command`} tone="dark" mono buttonLabel="Copy" /> : null}
      <p className="m-0 text-caption text-muted">{c.note}</p>
    </div>
  );
}

const STATE: Record<MarketplacePlugin['state'], { tone: Tone; label: string }> = {
  installed: { tone: 'ok', label: 'Installed' },
  available: { tone: 'neutral', label: 'Available' },
  update: { tone: 'warn', label: 'Update ready' },
};

export function PluginCard({ p, showPolicy }: { p: MarketplacePlugin; showPolicy?: boolean }) {
  const s = STATE[p.state];
  return (
    <article className="flex flex-col gap-3 rounded-lg bg-surface p-[18px] shadow-card">
      <div className="flex items-center gap-3">
        <ServerIcon letter={p.letter} color={p.color} size={40} square />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[15px] leading-[22px] font-semibold">{p.name}</h3>
          <p className="m-0 text-caption text-muted">{p.description}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {p.parts.map((x) => <Tag key={x}>{x}</Tag>)}
        {p.executable ? <Tag tone="bad" icon={<Terminal className="size-[11px]" aria-hidden="true" />}>Runs code locally</Tag> : null}
        {showPolicy ? <Tag tone="info">{p.policy === 'installedByDefault' ? 'Installed by default' : p.policy === 'required' ? 'Required' : 'Available'}</Tag> : null}
      </div>
      <div className="mt-auto"><StatusDot tone={s.tone} label={s.label} className="font-semibold" /></div>
    </article>
  );
}

/** One dot per release; the promoted release is marked, the draft is dashed. */
export function ReleaseTimeline({ releases }: { releases: MarketplaceDetail['releases'] }) {
  const n = releases.length;
  const x = (i: number) => (n === 1 ? 160 : 14 + (292 * i) / (n - 1));
  return (
    <div className="flex flex-col gap-1.5">
      <svg viewBox="0 0 320 40" width="100%" height="40" role="img" aria-label={`${n} releases; the promoted one is highlighted`}>
        <path d="M8 20H312" stroke="var(--line)" strokeWidth="2" />
        {releases.map((r, i) =>
          r.promoted ? (
            <g key={r.n}><circle cx={x(i)} cy="20" r="9" fill="var(--tangerine)" /><circle cx={x(i)} cy="20" r="13" fill="none" stroke="var(--tangerine)" strokeWidth="1.5" /></g>
          ) : r.draft ? (
            <circle key={r.n} cx={x(i)} cy="20" r="6" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="3 2" />
          ) : (
            <circle key={r.n} cx={x(i)} cy="20" r="5" fill="var(--line-strong)" />
          ),
        )}
      </svg>
      <div className="flex justify-between text-[11px] text-muted">
        <span>{releases[0] ? formatDate(releases[0].createdAt) : ''}</span>
        {releases.find((r) => r.promoted) ? <span className="font-semibold text-tangerine-ink">Promoted · {formatDate(releases.find((r) => r.promoted)?.createdAt ?? '')}</span> : null}
        {releases.some((r) => r.draft) ? <span>Draft</span> : null}
      </div>
    </div>
  );
}

const ADOPTION = {
  latest: { label: 'Latest', color: 'var(--tangerine)' },
  oneBehind: { label: 'One behind', color: 'var(--sky)' },
  older: { label: 'Older', color: 'var(--line-strong)' },
} as const;

export function AdoptionBar({ adoption }: { adoption: MarketplaceDetail['adoption'] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption text-muted">People by release</span>
      <div className="flex h-3.5 gap-0.5 overflow-hidden rounded-sm" role="img" aria-label={adoption.map((a) => `${ADOPTION[a.release].label}: ${a.people}`).join(', ')}>
        {adoption.map((a) => <span key={a.release} title={`${ADOPTION[a.release].label}: ${a.people}`} style={{ flex: a.people, background: ADOPTION[a.release].color }} />)}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        {adoption.map((a) => <span key={a.release} className="inline-flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: ADOPTION[a.release].color }} aria-hidden="true" />{ADOPTION[a.release].label}</span>)}
      </div>
    </div>
  );
}

export function MirrorStatus({ m }: { m: MarketplaceDetail['mirror'] }) {
  const tone: Tone = m.status === 'in_sync' ? 'ok' : m.status === 'behind' ? 'warn' : 'bad';
  return (
    <div className="flex items-center gap-2 rounded-md bg-sunken px-3 py-2.5">
      <StatusDot tone={tone} label={m.status === 'in_sync' ? 'In sync' : m.status === 'behind' ? 'Behind' : 'Failed'} hideLabel />
      <span className="flex-1 text-[13px] font-medium">{m.target} {m.status === 'in_sync' ? 'mirror in sync' : m.status === 'behind' ? 'mirror behind' : 'mirror failed'}</span>
      <span className="text-caption text-muted">for claude.ai and ChatGPT</span>
    </div>
  );
}

/** Releases, adoption, mirror and "Promote" for a marketplace (Managers and Admins). */
export function ReleasesCard({ id, link }: { id: string; link?: boolean }) {
  const q = useMarketplace(id);
  const promote = usePromoteRelease(id);
  const push = usePushMirror(id);
  return (
    <Card aria-label="Marketplace releases" className="gap-4">
      <CardHeader title="Releases" actions={link ? <Link to={`/plugins/marketplace/${id}`} className="text-label no-underline">Open</Link> : undefined} />
      <QueryBoundary query={q}>
        {(m) => {
          const draft = m.releases.find((r) => r.draft);
          return (
            <>
              <ReleaseTimeline releases={m.releases} />
              <AdoptionBar adoption={m.adoption} />
              <MirrorStatus m={m.mirror} />
              {m.mirror.status !== 'in_sync' ? <Button variant="outline" size="sm" onClick={() => push.mutate(undefined, { onSuccess: () => toast.success('Mirror pushed') })}>Sync now</Button> : null}
              {draft ? (
                <Button disabled={promote.isPending} onClick={() => promote.mutate(draft.n, { onSuccess: () => toast.success(`Release ${draft.n} promoted`) })}>Promote draft release</Button>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}

export function ApprovalsCard() {
  const q = useExecutableApprovals(true);
  const approve = useApproveExecutable();
  return (
    <QueryBoundary query={q} isEmpty={(d) => d.length === 0} empty={null}>
      {(items) => (
        <Card aria-label="Executable content approvals" className="gap-3.5">
          <CardHeader title="Waiting for approval" />
          {items.map((a) => (
            <div key={a.versionId} className="flex flex-col gap-3">
              <div className="flex items-center gap-2.5">
                <ServerIcon letter={a.letter} color={a.color} size={32} square />
                <div className="flex-1"><div className="text-[14px] font-semibold">{a.name}</div><div className="text-caption text-muted">by {a.author} · {a.summary}</div></div>
              </div>
              <pre aria-label="Diff" className="m-0 overflow-hidden whitespace-pre-wrap rounded-md bg-sunken p-3 font-mono text-[12px] leading-[18px]">
                {a.diff.map((l, i) => <span key={i} className={cn('block', l.startsWith('+') ? 'bg-mint-soft text-mint-ink' : 'text-muted')}>{l}</span>)}
              </pre>
              <div className="flex gap-2">
                <Button className="flex-1 bg-mint text-on-bright hover:bg-mint" onClick={() => approve.mutate({ entryId: a.entryId, versionId: a.versionId }, { onSuccess: () => toast.success(`${a.name} approved`) })}>Approve</Button>
                <Button variant="outline" className="flex-1">Send back</Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </QueryBoundary>
  );
}
