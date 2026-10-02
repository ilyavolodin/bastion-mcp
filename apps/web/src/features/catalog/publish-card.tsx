import * as React from 'react';
import { useAutoInstallPolicies, usePreviewAutoInstall, useTeamOptions } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { Card, CardHeader, Chip } from '@/components/primitives';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PolicyDialog, PreviewSummary } from './auto-install';
import type { Draft } from './draft';
import { NewTeamButton } from './team-picker';

type Props = {
  draft: Pick<Draft, 'visibility' | 'risk' | 'autoUpgrade'>;
  onChange: (patch: Partial<Pick<Draft, 'visibility' | 'risk' | 'autoUpgrade'>>) => void;
  versionLabel: string;
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
  disabledReason?: string | undefined;
  entryId?: string | undefined;
  noun?: string;
};

/** "Who gets it" and Publish: enabled only after a passing test of this exact version (11.3, 18.3). */
export function PublishCard({
  draft,
  onChange,
  versionLabel,
  canPublish,
  publishing,
  onPublish,
  disabledReason,
  noun = 'v',
}: Props) {
  const { me, role } = useAuth();
  const teams = useTeamOptions();
  // A team created a moment ago may not be in the refetched list yet: it still shows, by id, until the list catches up.
  const selected = draft.visibility.teamIds.map((id) => ({
    id,
    name: (teams.data ?? []).find((t) => t.id === id)?.name ?? id,
  }));
  const orgWide = draft.visibility.org;
  const mayOrgWide = me.capabilities.publishOrgWide || role === 'admin';
  return (
    <Card aria-label="Publish" className="gap-4">
      <CardHeader title="Who gets it" />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Visibility</legend>
        <label
          className={`flex min-h-11 items-center gap-2.5 rounded-md border px-3 ${orgWide ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'} ${mayOrgWide ? '' : 'opacity-60'}`}
        >
          <input
            type="radio"
            name="vis"
            checked={orgWide}
            disabled={!mayOrgWide}
            onChange={() => onChange({ visibility: { ...draft.visibility, org: true } })}
            className="size-[18px] accent-[var(--tangerine-ink)]"
          />
          <span className="flex-1 text-label">Everyone in {me.org.name}</span>
          {!mayOrgWide ? (
            <span className="text-caption text-muted">Needs publishOrgWide</span>
          ) : null}
        </label>
        <label
          className={`flex min-h-11 items-center gap-2.5 rounded-md border px-3 ${!orgWide ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'}`}
        >
          <input
            type="radio"
            name="vis"
            checked={!orgWide}
            onChange={() => onChange({ visibility: { ...draft.visibility, org: false } })}
            className="size-[18px] accent-[var(--tangerine-ink)]"
          />
          <span className="flex-1 text-label">Selected teams</span>
        </label>
      </fieldset>
      {!orgWide ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-1">
          {selected.map((t) => (
            <Chip
              key={t.id}
              onRemove={() =>
                onChange({
                  visibility: {
                    ...draft.visibility,
                    teamIds: draft.visibility.teamIds.filter((x) => x !== t.id),
                  },
                })
              }
              removeLabel={`Remove ${t.name}`}
            >
              {t.name}
            </Chip>
          ))}
          <Select
            aria-label="Add team"
            value=""
            className="h-7 w-auto rounded-full border-dashed py-0 text-caption"
            onChange={(e) =>
              e.target.value &&
              onChange({
                visibility: {
                  ...draft.visibility,
                  teamIds: [...draft.visibility.teamIds, e.target.value],
                },
              })
            }
          >
            <option value="">+ Add team</option>
            {(teams.data ?? [])
              .filter((t) => !draft.visibility.teamIds.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
          {role === 'admin' ? (
            <NewTeamButton
              onCreated={(team) =>
                onChange({
                  visibility: {
                    ...draft.visibility,
                    teamIds: [...new Set([...draft.visibility.teamIds, team.id])],
                  },
                })
              }
            />
          ) : null}
          {selected.length === 0 && (teams.data ?? []).length === 0 ? (
            <span className="w-full text-caption text-muted">
              {role === 'admin'
                ? 'No teams yet: create one to share this with.'
                : 'No teams yet: ask an Admin to create one.'}
            </span>
          ) : null}
        </div>
      ) : null}
      <RoleGate roles={['admin']}>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold">Risk</span>
          <div role="group" aria-label="Risk" className="flex gap-1 rounded-md bg-sunken p-1">
            {(['low', 'medium', 'high'] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={draft.risk === r}
                onClick={() => onChange({ risk: r })}
                className={`h-9 flex-1 rounded-sm text-[13px] capitalize ${draft.risk === r ? 'bg-surface font-semibold shadow-[0_0_0_1.5px_var(--tangerine-ink)]' : 'text-muted'}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </RoleGate>
      <label className="flex items-center gap-2.5 text-[14px]">
        <Switch checked={draft.autoUpgrade} onCheckedChange={(v) => onChange({ autoUpgrade: v })} />
        Installs follow new versions
      </label>
      <Button size="lg" disabled={!canPublish || publishing} onClick={onPublish}>
        {publishing ? 'Publishing…' : `Publish ${noun}${versionLabel}`}
      </Button>
      {!canPublish && disabledReason ? (
        <p className="m-0 text-caption text-muted">{disabledReason}</p>
      ) : null}
    </Card>
  );
}

export function AutoInstallCard({ entryId }: { entryId: string | undefined }) {
  const policies = useAutoInstallPolicies();
  const preview = usePreviewAutoInstall();
  const [open, setOpen] = React.useState(false);
  const mine = (policies.data ?? []).filter((p) => p.catalogEntryId === entryId);
  const first = mine[0];
  const { mutate } = preview;
  const firstId = first?.id;
  React.useEffect(() => {
    if (firstId) mutate({ id: firstId, changes: {} });
  }, [firstId, mutate]);
  return (
    <Card aria-label="Auto-install preview" className="gap-3.5">
      <CardHeader title="Auto-install" />
      {first ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {first.targets.map((t) => (
              <Chip key={t.id} tone="info">
                {t.label}
              </Chip>
            ))}
            <Chip>{first.applyToExisting ? 'New and existing people' : 'New people only'}</Chip>
          </div>
          <PreviewSummary preview={preview.data} />
        </>
      ) : (
        <p className="m-0 text-muted">
          No policy yet. People find this in the Store, or you can put it in their accounts.
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!entryId}
        onClick={() => setOpen(true)}
      >
        {first ? 'Edit policy' : 'Add auto-install policy'}
      </Button>
      <PolicyDialog open={open} onOpenChange={setOpen} policy={first ?? null} entryId={entryId} />
    </Card>
  );
}
