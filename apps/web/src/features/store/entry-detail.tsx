import { Link } from '@tanstack/react-router';
import { Globe, KeyRound, Link2, ScrollText, ShieldCheck, X } from 'lucide-react';
import type * as React from 'react';
import { needsOauth, type StoreEntryDetailView } from '@/api/views/servers';
import { ServerIcon, Tag } from '@/components/primitives';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { RUNTIME_LABEL } from '@/lib/format';

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

const RISK_TONE = { low: 'ok', medium: 'warn', high: 'bad' } as const;

/** Store side panel (18.3): what you'll need, network reach, isolation and Install. */
export function EntryDetail({
  entry,
  onInstall,
  onClose,
  docked,
}: {
  entry: StoreEntryDetailView;
  onInstall: () => void;
  onClose?: () => void;
  docked?: boolean;
}) {
  const spec = entry.spec;
  const oauth = needsOauth(spec);
  const apiKey = entry.secrets.length > 0 || spec?.authMode === 'userSecret';
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
            {spec
              ? `${spec.runtime === 'remote' ? 'Remote MCP' : `${RUNTIME_LABEL[spec.runtime]} MCP`} · `
              : `${entry.category} · `}
            {entry.version ? `v${entry.version.label}` : 'no published version'}
          </p>
        </div>
        {onClose ? (
          <Button variant="sunken" size="icon" onClick={onClose} aria-label="Close details">
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <p className="m-0">{entry.description}</p>
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={RISK_TONE[entry.risk]}>{entry.risk} risk</Tag>
        {entry.tags.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>

      <section aria-label="What you’ll need" className="flex flex-col gap-2">
        <span className="text-overline">What you’ll need</span>
        <div className="grid grid-cols-3 gap-2">
          <Need
            icon={<Link2 />}
            needed={oauth}
            tone="tangerine"
            label={oauth ? `${entry.displayName} sign-in` : 'No sign-in'}
          />
          <Need
            icon={<KeyRound />}
            needed={apiKey}
            tone="berry"
            label={apiKey ? 'Your API key' : 'No API key'}
          />
          <Need
            icon={<ScrollText />}
            needed={entry.variables.length > 0}
            tone="tangerine"
            label={
              entry.variables.length > 0
                ? `${entry.variables.length} ${entry.variables.length === 1 ? 'setting' : 'settings'}`
                : 'No settings'
            }
          />
        </div>
      </section>

      {entry.version?.changelog ? (
        <section aria-label="What’s new" className="flex flex-col gap-1">
          <span className="text-overline">What’s new in {entry.version.label}</span>
          <p className="m-0 text-[13px] text-muted">{entry.version.changelog}</p>
        </section>
      ) : null}

      {spec ? (
        <section aria-label="Reaches" className="flex flex-col gap-2">
          <span className="text-overline">Reaches</span>
          <div className="flex flex-wrap gap-1.5">
            {spec.hosts.length === 0 ? (
              <span className="text-caption text-muted">Nothing outside Bastion.</span>
            ) : (
              spec.hosts.map((h) => (
                <span
                  key={h}
                  className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-sunken px-2.5 text-caption font-medium"
                >
                  <Globe className="size-3 text-muted" aria-hidden="true" />
                  {h}
                </span>
              ))
            )}
          </div>
          {spec.sandboxed ? (
            <div className="flex flex-wrap gap-1.5">
              <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-sky-soft px-2.5 text-caption font-semibold text-sky-ink">
                <ShieldCheck className="size-3" aria-hidden="true" />
                Runs in a sandbox
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      {entry.installed ? (
        <Button size="lg" variant="outline" disabled>
          Installed
        </Button>
      ) : (
        <Button size="lg" onClick={onInstall} disabled={!entry.version}>
          Install
        </Button>
      )}

      <RoleGate roles={['admin', 'manager']}>
        <div className="flex flex-col gap-2.5 rounded-md bg-sunken p-3.5">
          <span className="text-[13px] font-semibold">Catalog entry</span>
          <div className="flex items-center gap-2.5">
            <span className="flex-1 text-caption text-muted">
              {entry.version ? `Current version ${entry.version.label}` : 'No published version'}
            </span>
            <Link to={`/catalog/${entry.id}`} className="text-label no-underline">
              Edit
            </Link>
          </div>
        </div>
      </RoleGate>
    </aside>
  );
}
