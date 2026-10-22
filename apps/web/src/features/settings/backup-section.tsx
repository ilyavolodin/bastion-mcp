import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useCreateBackup, useMaintenance, useRestoreBackup, useSetMaintenance } from '@/api/hooks';
import type { Res } from '@/api/schema';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';

type Restore = Res<'post', '/system/restore'>;

/** The shortest passphrase the server accepts. */
const MIN_PASSPHRASE = 12;

const problemText = (error: unknown): string =>
  error instanceof ApiError
    ? [error.detail || error.title, ...error.errors.map((e) => e.message)].join(': ')
    : error instanceof Error
      ? error.message
      : 'The request failed';

const toBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const download = (name: string, base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

// --- maintenance mode -----------------------------------------------------------------------------------------

function MaintenanceCard() {
  const q = useMaintenance();
  const set = useSetMaintenance();
  return (
    <Card aria-label="Maintenance mode" className="gap-3.5">
      <CardHeader title="Maintenance mode" />
      <QueryBoundary query={q} label="Loading maintenance mode">
        {(m) => (
          <>
            <p className="m-0 text-muted">
              Stops all MCP and OAuth traffic on every replica (they answer 503) and rejects changes
              from the console, so nothing writes while you restore. You stay signed in and can
              still read, back up and restore.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill
                tone={m.enabled ? 'warn' : 'ok'}
                label={m.enabled ? 'Traffic stopped' : 'Serving traffic'}
              />
              {m.enabled && m.since ? (
                <span className="text-caption text-muted">since {formatDate(m.since)}</span>
              ) : null}
              <Button
                variant={m.enabled ? 'primary' : 'outline'}
                disabled={set.isPending}
                onClick={() =>
                  set.mutate(!m.enabled, {
                    onError: (e) => toast.error(problemText(e)),
                  })
                }
              >
                {set.isPending
                  ? m.enabled
                    ? 'Resuming…'
                    : 'Stopping traffic…'
                  : m.enabled
                    ? 'Resume traffic'
                    : 'Stop all traffic'}
              </Button>
            </div>
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

// --- backup ---------------------------------------------------------------------------------------------------------

function BackupCard() {
  const create = useCreateBackup();
  const [passphrase, setPassphrase] = React.useState('');
  const [again, setAgain] = React.useState('');
  const short = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = again.length > 0 && again !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE && again === passphrase;
  return (
    <Card aria-label="Backup" className="gap-3.5">
      <CardHeader title="Create a backup" />
      <p className="m-0 text-muted">
        One encrypted file with the whole configuration: catalog, policies and settings, users and
        teams, every installation with its per-user settings, OAuth connections, token hashes, the
        audit log and all stored secrets. It does not include call logs or statistics.
      </p>
      <form
        className="flex max-w-md flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          create.mutate(passphrase, {
            onSuccess: (r) => {
              download(r.filename, r.data);
              toast.success(`Backup downloaded (${Math.ceil(r.size / 1024)} KiB)`);
              setPassphrase('');
              setAgain('');
            },
            onError: (err) => toast.error(problemText(err)),
          });
        }}
      >
        <Field
          label="Passphrase"
          required
          help={`At least ${MIN_PASSPHRASE} characters. It encrypts the whole file. Nobody, including us, can recover a backup without it.`}
          error={short ? `Use at least ${MIN_PASSPHRASE} characters` : undefined}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Repeat the passphrase"
          required
          error={mismatch ? 'The passphrases differ' : undefined}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          )}
        </Field>
        <p className="m-0 text-caption text-muted">
          The file contains every secret. Store it and the passphrase in different places.
        </p>
        <div>
          <Button type="submit" disabled={!ready || create.isPending}>
            {create.isPending ? 'Creating backup…' : 'Create and download backup'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// --- restore --------------------------------------------------------------------------------------------------------

function ReportTable({ report }: { report: Restore }) {
  const rows = Object.entries(report.tables).filter(
    ([, t]) => t.rows > 0 || t.existing > 0 || t.action === 'skip',
  );
  const merge = report.mode === 'merge';
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[13px] font-medium">
        {report.dryRun ? 'Preview' : 'Restored'} ({report.mode}): backup of{' '}
        {formatDate(report.backup.createdAt)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-caption text-muted">
              <th className="py-1 pr-4 font-medium">Table</th>
              <th className="py-1 pr-4 font-medium">In the backup</th>
              <th className="py-1 font-medium">
                {merge ? 'Already here (overwritten)' : 'Here now (removed)'}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, t]) => (
              <tr key={name} className="border-t border-line">
                <td className="py-1 pr-4 font-mono">{name}</td>
                <td className="py-1 pr-4">
                  {t.action === 'skip' ? (
                    <span className="text-muted">skipped{t.note ? `: ${t.note}` : ''}</span>
                  ) : (
                    t.rows
                  )}
                </td>
                <td className="py-1">{t.existing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.warnings.map((w) => (
        <p key={w} className="m-0 text-caption text-muted">
          {w}
        </p>
      ))}
    </div>
  );
}

function RestoreCard() {
  const restore = useRestoreBackup();
  const maintenance = useMaintenance();
  const qc = useQueryClient();
  const [file, setFile] = React.useState<File | null>(null);
  const [passphrase, setPassphrase] = React.useState('');
  const [mode, setMode] = React.useState<'merge' | 'replace'>('merge');
  const [report, setReport] = React.useState<Restore | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const stopped = maintenance.data?.enabled === true;
  const ready = file !== null && passphrase.length > 0;

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setError(null);
    try {
      const view = await restore.mutateAsync({
        data: await toBase64(file),
        passphrase,
        mode,
        dryRun,
      });
      setReport(view);
      if (!dryRun) {
        toast.success(mode === 'replace' ? 'Backup restored (replace)' : 'Backup restored (merge)');
        // Everything on screen may have changed.
        await qc.invalidateQueries();
      }
    } catch (e) {
      setReport(null);
      setError(problemText(e));
    }
  };

  return (
    <Card aria-label="Restore" className="gap-3.5">
      <CardHeader title="Restore a backup" />
      <p className="m-0 text-muted">
        Preview first: nothing changes until you restore. Sessions are not part of a backup; people
        whose accounts are not in the backup are signed out.
      </p>
      <form
        className="flex max-w-xl flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
        <Field label="Backup file" required>
          {({ id }) => (
            <Input
              id={id}
              type="file"
              accept=".bastion-backup,application/octet-stream"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setReport(null);
              }}
            />
          )}
        </Field>
        <Field label="Backup passphrase" required>
          {({ id, describedBy }) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              aria-describedby={describedBy}
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setReport(null);
              }}
            />
          )}
        </Field>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-[13px] font-medium">How to restore</legend>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="restore-mode"
              checked={mode === 'merge'}
              onChange={() => {
                setMode('merge');
                setReport(null);
              }}
            />
            <span>
              <span className="font-medium">Merge</span>
              <span className="block text-caption text-muted">
                Adds what is missing and overwrites rows with the same id. Nothing is deleted, and
                the keys and audit log of this installation stay.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="restore-mode"
              checked={mode === 'replace'}
              onChange={() => {
                setMode('replace');
                setReport(null);
              }}
            />
            <span>
              <span className="font-medium">Replace</span>
              <span className="block text-caption text-muted">
                Deletes everything the backup covers and loads the backup, including signing keys
                and the audit log. For recovery after a disaster. Needs maintenance mode.
              </span>
            </span>
          </label>
        </fieldset>
        {mode === 'replace' && !stopped ? (
          <p role="status" className="m-0 text-caption font-medium text-coral-ink">
            Turn on maintenance mode above before you restore with Replace.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" variant="outline" disabled={!ready || restore.isPending}>
            {restore.isPending ? 'Working…' : 'Preview'}
          </Button>
          <Button
            type="button"
            disabled={
              !ready || restore.isPending || report === null || (mode === 'replace' && !stopped)
            }
            onClick={() => (mode === 'replace' ? setConfirming(true) : void run(false))}
          >
            Restore
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="m-0 font-medium text-coral-ink">
          {error}
        </p>
      ) : null}
      {report ? <ReportTable report={report} /> : null}

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setTyped('');
        }}
      >
        <DialogContent
          title="Replace everything?"
          description="This deletes the current configuration, users, installations and secrets and loads the backup. It cannot be undone."
        >
          <Field label="Type REPLACE to confirm">
            {({ id }) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Field>
          <div className="flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              disabled={typed !== 'REPLACE' || restore.isPending}
              onClick={() => {
                setConfirming(false);
                setTyped('');
                void run(false);
              }}
            >
              Replace everything
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Backup and restore of the whole installation (CLI: `bastion backup`, `bastion restore`). */
export function BackupSection() {
  return (
    <div className="flex flex-col gap-6">
      <MaintenanceCard />
      <BackupCard />
      <RestoreCard />
    </div>
  );
}
