import { Link } from '@tanstack/react-router';
import { Globe, KeyRound, Link2, ScrollText, ShieldCheck, X } from 'lucide-react';
import type * as React from 'react';
import type { CapabilityItem, StoreEntryDetail } from '@/api/types';
import { RoleGate } from '@/components/role-gate';
import { ServerIcon, Tag } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { RUNTIME_LABEL } from '@/lib/format';

const ACCESS: Record<NonNullable<CapabilityItem['access']>, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  read: { label: 'Read-only', tone: 'ok' },
  write: { label: 'Writes', tone: 'warn' },
  destructive: { label: 'Destructive', tone: 'bad' },
};

export function AccessTag({ access }: { access: CapabilityItem['access'] }) {
  if (!access) return null;
  const a = ACCESS[access];
  return <Tag tone={a.tone}>{a.label}</Tag>;
}

function Need({
  icon,
  label,
  needed,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  needed: boolean;
  tone: 'tangerine' | 'berry';
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-md px-1.5 py-3 text-center text-caption',
        needed
          ? tone === 'tangerine'
            ? 'bg-tangerine-soft font-semibold text-tangerine-ink'
            : 'bg-berry-soft font-semibold text-berry-ink'
          : 'bg-sunken font-medium text-muted',
      )}
    >
      <span className="[&_svg]:size-[22px]" aria-hidden="true">
        {icon}
      </span>
      {label}
    </div>
  );
}

/** Version dots (4 versions, the current one filled and larger). */
function VersionLine({ count }: { count: number }) {
  const n = Math.max(1, Math.min(count, 6));
  return (
    <svg viewBox="0 0 160 24" width="160" height="24" aria-hidden="true">
      <path d="M6 12h148" stroke="var(--line)" strokeWidth="2" />
      {Array.from({ length: n }, (_, i) => {
        const x = n === 1 ? 150 : 10 + (140 * i) / (n - 1);
        const last = i === n - 1;
        return <circle key={i} cx={x} cy="12" r={last ? 6 : 4} fill={last ? 'var(--tangerine)' : 'var(--line-strong)'} />;
      })}
    </svg>
  );
}

/** Store side panel (18.3): tools, what you'll need, network reach, isolation and Install. */
export function EntryDetail({
  entry,
  onInstall,
  onClose,
  docked,
}: {
  entry: StoreEntryDetail;
  onInstall: () => void;
  onClose?: () => void;
  docked?: boolean;
}) {
  const tools = entry.items.filter((i) => i.kind === 'tool');
  const others = entry.items.filter((i) => i.kind !== 'tool');
  return (
    <aside
      aria-label={`${entry.displayName} details`}
      className={cn(
        'flex flex-col gap-[18px] bg-surface',
        docked && 'w-[400px] shrink-0 rounded-lg p-6 shadow-float',
      )}
    >
      <div className="flex items-start gap-3">
        <ServerIcon letter={entry.letter} color={entry.color} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-card-title">{entry.displayName}</h2>
          <p className="m-0 mt-0.5 text-caption text-muted">
            {entry.runtime === 'remote' ? 'Remote MCP' : `${RUNTIME_LABEL[entry.runtime]} MCP`} · v{entry.version} · published by{' '}
            {entry.publisher}
          </p>
        </div>
        {onClose ? (
          <Button variant="sunken" size="icon" onClick={onClose} aria-label="Close details">
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <p className="m-0">{entry.summary}</p>

      <section aria-label="What you’ll need" className="flex flex-col gap-2">
        <span className="text-overline">What you’ll need</span>
        <div className="grid grid-cols-3 gap-2">
          <Need
            icon={<Link2 />}
            needed={Boolean(entry.setup.oauthProvider)}
            tone="tangerine"
            label={entry.setup.oauthProvider ?? 'No sign-in'}
          />
          <Need
            icon={<KeyRound />}
            needed={entry.setup.needsApiKey}
            tone="berry"
            label={entry.setup.needsApiKey ? 'Your API key' : 'No API key'}
          />
          <Need
            icon={<ScrollText />}
            needed={entry.setup.settings > 0}
            tone="tangerine"
            label={entry.setup.settings > 0 ? `${entry.setup.settings} setting` : 'No settings'}
          />
        </div>
      </section>

      <section aria-label="Tools" className="flex flex-col gap-2">
        <span className="text-overline">Tools · {tools.length}</span>
        <ul className="m-0 list-none p-0">
          {tools.map((t) => (
            <li key={t.name} className="flex h-8 items-center gap-2 border-b border-line">
              <span className="flex-1 font-mono text-[13px] font-medium">{t.name}</span>
              <AccessTag access={t.access} />
            </li>
          ))}
        </ul>
        {others.length > 0 ? (
          <p className="m-0 text-caption text-muted">
            Also {others.length} {others.length === 1 ? 'prompt or resource' : 'prompts and resources'}.
          </p>
        ) : null}
      </section>

      <section aria-label="Reaches" className="flex flex-col gap-2">
        <span className="text-overline">Reaches</span>
        <div className="flex flex-wrap gap-1.5">
          {entry.egressHosts.length === 0 ? (
            <span className="text-caption text-muted">Nothing outside Bastion.</span>
          ) : (
            entry.egressHosts.map((h) => (
              <span key={h} className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-sunken px-2.5 text-caption font-medium">
                <Globe className="size-3 text-muted" aria-hidden="true" />
                {h}
              </span>
            ))
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {entry.isolation !== 'none' ? (
            <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-sky-soft px-2.5 text-caption font-semibold text-sky-ink">
              <ShieldCheck className="size-3" aria-hidden="true" />
              {entry.isolation === 'gvisor' ? 'gVisor sandbox' : 'Namespace sandbox'}
            </span>
          ) : null}
          {entry.guards.map((g) => (
            <span key={g} className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-sky-soft px-2.5 text-caption font-semibold text-sky-ink">
              <ShieldCheck className="size-3" aria-hidden="true" />
              {g}
            </span>
          ))}
        </div>
      </section>

      {entry.installed ? (
        <Button size="lg" variant="outline" disabled>
          Installed
        </Button>
      ) : (
        <Button size="lg" onClick={onInstall}>
          Install
        </Button>
      )}

      <RoleGate roles={['admin', 'manager']}>
        {entry.canEdit ? (
          <div className="flex flex-col gap-2.5 rounded-md bg-sunken p-3.5">
            <span className="text-[13px] font-semibold">Catalog entry</span>
            <div className="flex items-center gap-2.5">
              <VersionLine count={entry.versions.length} />
              <span className="flex-1 text-caption text-muted">{entry.versions.length} versions</span>
              <Link to={`/catalog/c-${entry.slug}`} className="text-label no-underline">
                Edit
              </Link>
            </div>
          </div>
        ) : null}
      </RoleGate>
    </aside>
  );
}
