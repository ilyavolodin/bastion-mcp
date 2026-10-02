import { Link } from '@tanstack/react-router';
import type { InstallationView } from '@/api/views/servers';
import { ServerIcon } from '@/components/primitives';
import { InstallationStatus } from '@/components/status';
import { installationAction, RUNTIME_LABEL } from '@/lib/format';

const metaText = (i: InstallationView): string => {
  const rt = i.runtime === 'remote' ? 'Remote' : `${RUNTIME_LABEL[i.runtime]} sandbox`;
  const auth = i.authMode === 'oauth' ? 'OAuth' : i.authMode === 'userSecret' ? 'API key' : null;
  const owner = i.ownerType === 'team' ? 'Team' : null;
  return [rt, auth ?? owner].filter(Boolean).join(' · ');
};

/** Installation tile: icon, name, status, owner, or the action when setup is needed. */
export function InstallationTile({ installation: i }: { installation: InstallationView }) {
  const action = installationAction(i);
  return (
    <Link
      to={`/servers/${i.id}`}
      className="flex min-h-[150px] flex-col gap-3 rounded-lg bg-surface p-[18px] text-ink no-underline shadow-card hover:text-ink"
    >
      <div className="flex items-center gap-3">
        <ServerIcon letter={i.letter} color={i.color} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] leading-[22px] font-semibold">{i.displayName}</span>
          <span className="text-caption text-muted">{metaText(i)}</span>
        </span>
      </div>
      <InstallationStatus status={i.status} />
      {action ? (
        <span className="inline-flex h-9 items-center justify-center rounded-md bg-tangerine-soft text-[13px] font-medium text-tangerine-ink">
          {action.label}
        </span>
      ) : (
        <span className="text-caption text-muted">
          {i.ownerType === 'team' ? `Shared with ${i.ownerName}` : `Yours · /${i.slug}`}
        </span>
      )}
    </Link>
  );
}
