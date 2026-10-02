import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  useApproveExecutable,
  useDistribution,
  useExecutableApprovals,
  useMirror,
  usePromoteRelease,
  usePushMirror,
  useReleases,
} from '@/api/hooks';
import {
  type ChannelTotal,
  type ClientSetup,
  mirrorSummary,
  type PluginView,
  type ReleaseView,
} from '@/api/views/plugins';
import { CopyField } from '@/components/copy-field';
import { Card, CardHeader, ServerIcon, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusDot } from '@/components/status';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

const BADGE: Record<string, string> = {
  'claude-code': '>_',
  codex: 'Cx',
  'claude-ai': 'C',
  chatgpt: 'GP',
};

/** Set up panel for one client: the exact command or step to follow. */
export function ClientSetupCard({ c }: { c: ClientSetup }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-sunken text-[11px] font-semibold">
          {BADGE[c.client] ?? c.label.charAt(0)}
        </span>
        <span className="flex-1 text-[14px] font-semibold">{c.label}</span>
      </div>
      {c.command ? (
        <CopyField
          value={c.command}
          label={`${c.label} command`}
          tone="dark"
          mono
          buttonLabel="Copy"
        />
      ) : null}
      <p className="m-0 text-caption text-muted">{c.note}</p>
    </div>
  );
}

const POLICY_LABEL = {
  installedByDefault: 'Installed by default',
  required: 'Required',
  available: 'Available',
} as const;

export function PluginCard({ p, showPolicy }: { p: PluginView; showPolicy?: boolean }) {
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
        <Tag>v{p.version}</Tag>
        {showPolicy || p.policy !== 'available' ? (
          <Tag tone="info">{POLICY_LABEL[p.policy]}</Tag>
        ) : null}
      </div>
    </article>
  );
}

/** One dot per release, oldest first; the promoted release is marked, the one waiting for promotion is dashed. */
export function ReleaseTimeline({ releases }: { releases: ReleaseView[] }) {
  const n = releases.length;
  const x = (i: number) => (n === 1 ? 160 : 14 + (292 * i) / (n - 1));
  const promoted = releases.find((r) => r.promoted);
  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox="0 0 320 40"
        width="100%"
        height="40"
        role="img"
        aria-label={`${n} releases; the promoted one is highlighted`}
      >
        <path d="M8 20H312" stroke="var(--line)" strokeWidth="2" />
        {releases.map((r, i) =>
          r.promoted ? (
            <g key={r.seq}>
              <circle cx={x(i)} cy="20" r="9" fill="var(--tangerine)" />
              <circle
                cx={x(i)}
                cy="20"
                r="13"
                fill="none"
                stroke="var(--tangerine)"
                strokeWidth="1.5"
              />
            </g>
          ) : r.draft ? (
            <circle
              key={r.seq}
              cx={x(i)}
              cy="20"
              r="6"
              fill="var(--surface)"
              stroke="var(--line-strong)"
              strokeWidth="1.5"
              strokeDasharray="3 2"
            />
          ) : (
            <circle key={r.seq} cx={x(i)} cy="20" r="5" fill="var(--line-strong)" />
          ),
        )}
      </svg>
      <div className="flex justify-between text-[11px] text-muted">
        <span>{releases[0] ? formatDate(releases[0].releaseTime) : ''}</span>
        {promoted ? (
          <span className="font-semibold text-tangerine-ink">
            Promoted · {formatDate(promoted.releaseTime)}
          </span>
        ) : null}
        {releases.some((r) => r.draft) ? <span>Draft</span> : null}
      </div>
    </div>
  );
}

const CHANNEL_COLORS = ['var(--tangerine)', 'var(--sky)', 'var(--line-strong)', 'var(--teal)'];

/** How the marketplace was fetched, per channel (25.9). */
export function DistributionBar({ totals }: { totals: ChannelTotal[] }) {
  if (totals.length === 0) {
    return <span className="text-caption text-muted">No fetches yet.</span>;
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption text-muted">Fetches by channel</span>
      <div
        className="flex h-3.5 gap-0.5 overflow-hidden rounded-sm"
        role="img"
        aria-label={totals.map((t) => `${t.label}: ${t.count}`).join(', ')}
      >
        {totals.map((t, i) => (
          <span
            key={t.channel}
            title={`${t.label}: ${t.count}`}
            style={{ flex: t.count, background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        {totals.map((t, i) => (
          <span key={t.channel} className="inline-flex items-center gap-1">
            <span
              className="size-2 rounded-full"
              style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }}
              aria-hidden="true"
            />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MirrorStatus({ summary }: { summary: ReturnType<typeof mirrorSummary> }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-sunken px-3 py-2.5">
      <StatusDot tone={summary.tone} label={summary.label} hideLabel />
      <span className="flex-1 text-[13px] font-medium">
        {summary.target ? `${summary.target} mirror ${summary.label}` : summary.label}
      </span>
      {summary.target ? (
        <span className="text-caption text-muted">for claude.ai and ChatGPT</span>
      ) : null}
    </div>
  );
}

/** Releases, distribution, mirror and "Promote" for a marketplace (Managers and Admins). */
export function ReleasesCard({ id, link }: { id: string; link?: boolean }) {
  const releases = useReleases(id);
  const mirror = useMirror(id);
  const distribution = useDistribution(id);
  const promote = usePromoteRelease(id);
  const push = usePushMirror(id);
  return (
    <Card aria-label="Marketplace releases" className="gap-4">
      <CardHeader
        title="Releases"
        actions={
          link ? (
            <Link to={`/plugins/marketplace/${id}`} className="text-label no-underline">
              Open
            </Link>
          ) : undefined
        }
      />
      <QueryBoundary query={releases}>
        {(list) => {
          const draft = list.find((r) => r.draft);
          const summary = mirrorSummary(mirror.data);
          return (
            <>
              <ReleaseTimeline releases={list} />
              <DistributionBar totals={distribution.data ?? []} />
              <MirrorStatus summary={summary} />
              {summary.needsPush ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={push.isPending}
                  onClick={() =>
                    push.mutate(undefined, { onSuccess: () => toast.success('Mirror pushed') })
                  }
                >
                  Sync now
                </Button>
              ) : null}
              {draft ? (
                <Button
                  disabled={promote.isPending}
                  onClick={() =>
                    promote.mutate(draft.seq, {
                      onSuccess: () => toast.success(`Release ${draft.seq} promoted`),
                    })
                  }
                >
                  Promote draft release
                </Button>
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
                <div className="flex-1">
                  <div className="text-[14px] font-semibold">{a.name}</div>
                  <div className="text-caption text-muted">
                    by {a.author} · {a.summary}
                  </div>
                </div>
              </div>
              <pre
                role="group"
                aria-label="Diff"
                className="m-0 overflow-hidden whitespace-pre-wrap rounded-md bg-sunken p-3 font-mono text-[12px] leading-[18px]"
              >
                {a.diff.map((l, i) => (
                  <span
                    key={i}
                    className={cn(
                      'block',
                      l.startsWith('+') ? 'bg-mint-soft text-mint-ink' : 'text-muted',
                    )}
                  >
                    {l}
                  </span>
                ))}
              </pre>
              <div className="flex gap-2">
                <Button
                  className="flex-1 bg-mint text-on-bright hover:bg-mint"
                  onClick={() =>
                    approve.mutate(
                      { entryId: a.entryId, versionId: a.versionId },
                      { onSuccess: () => toast.success(`${a.name} approved`) },
                    )
                  }
                >
                  Approve
                </Button>
                <Button variant="outline" className="flex-1">
                  Send back
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </QueryBoundary>
  );
}
