import { Link } from '@tanstack/react-router';
import { CircleCheck, CircleX, MoreHorizontal } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import {
  useDeleteCatalogEntry,
  usePublishEntry,
  useSetEntryStatus,
  useTeamOptions,
} from '@/api/hooks';
import type { CatalogStatus } from '@/api/schema';
import type { CatalogEntryView } from '@/api/views/catalog';
import type { Me, UiRole } from '@/api/views/session';
import { useAuth } from '@/auth/auth';
import { ProblemAlert } from '@/components/problem';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export const STATUS: Record<
  CatalogStatus,
  { tone: 'ok' | 'warn' | 'neutral' | 'bad'; label: string }
> = {
  published: { tone: 'ok', label: 'Published' },
  draft: { tone: 'warn', label: 'Draft' },
  deprecated: { tone: 'neutral', label: 'Deprecated' },
  archived: { tone: 'bad', label: 'Archived' },
};

export const editorPath = (e: Pick<CatalogEntryView, 'id' | 'kind'>) =>
  e.kind === 'mcp_server' ? `/catalog/${e.id}` : `/plugins/edit/${e.id}`;

/** Admins manage every entry; a Manager only those owned by a team they manage; Auditors none (10.1). */
export const canManageEntry = (
  role: UiRole,
  me: Pick<Me, 'teams'>,
  entry: { ownerTeamId: string | null },
): boolean =>
  role === 'admin' ||
  (role === 'manager' &&
    entry.ownerTeamId !== null &&
    me.teams.some((t) => t.id === entry.ownerTeamId && t.role === 'manager'));

export const useCanManageEntry = (entry: { ownerTeamId: string | null }): boolean => {
  const { role, me } = useAuth();
  return canManageEntry(role, me, entry);
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `entry_in_use` carries the guidance itself (what uses the entry and what to do); anything else is a plain problem. */
function DialogError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'entry_in_use') {
    return (
      <div role="alert" className="rounded-lg bg-coral-soft p-4 text-[13px] text-ink">
        <p className="m-0 font-semibold text-coral-ink">This entry is in use</p>
        <p className="m-0 mt-0.5">{error.detail}</p>
      </div>
    );
  }
  return <ProblemAlert error={error} />;
}

/** A confirmation: names what happens, focuses the safe button first, closes on Esc. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  pending,
  error,
  confirmDisabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending: boolean;
  error: unknown;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const confirm = React.useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        onOpenAutoFocus={(e) => {
          // A destructive confirmation starts on Cancel; a constructive one on its confirm button.
          e.preventDefault();
          (destructive ? cancel : confirm).current?.focus();
        }}
      >
        {children}
        {error ? <DialogError error={error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            ref={confirm}
            variant={destructive ? 'danger' : 'primary'}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button ref={cancel} variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Dialogs = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DeleteEntryDialog({
  entry,
  open,
  onOpenChange,
  onDeleted,
}: Dialogs & {
  entry: Pick<CatalogEntryView, 'id' | 'displayName' | 'status'>;
  onDeleted?: () => void;
}) {
  // The row (or the editor) may be gone by the time the request returns: the hook-level callback still runs.
  const del = useDeleteCatalogEntry(() => {
    toast.success(`${entry.displayName} deleted`);
    onOpenChange(false);
    onDeleted?.();
  });
  const { reset } = del;
  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  const draft = entry.status === 'draft';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${entry.displayName}?`}
      description={
        draft
          ? 'This permanently removes the draft, its versions and files, and the hidden test installation its test runs created. It cannot be undone.'
          : 'This permanently removes the entry and all its versions from the catalog and the Store. It cannot be undone.'
      }
      confirmLabel={`Delete ${draft ? 'draft' : 'entry'}`}
      destructive
      pending={del.isPending}
      error={del.error}
      onConfirm={() => del.mutate(entry.id)}
    >
      {draft ? null : (
        <p className="m-0 text-[13px] text-muted">
          An entry that people have installed cannot be deleted: deprecate it to hide it from the
          Store, or remove the installations first.
        </p>
      )}
    </ConfirmDialog>
  );
}

export function StatusEntryDialog({
  entry,
  status,
  open,
  onOpenChange,
}: Dialogs & {
  entry: Pick<CatalogEntryView, 'id' | 'displayName'>;
  status: 'deprecated' | 'archived';
}) {
  const deprecate = status === 'deprecated';
  const set = useSetEntryStatus(() => {
    toast.success(`${entry.displayName} ${deprecate ? 'deprecated' : 'archived'}`);
    onOpenChange(false);
  });
  const { reset } = set;
  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${deprecate ? 'Deprecate' : 'Archive'} ${entry.displayName}?`}
      description={
        deprecate
          ? 'It disappears from the Store, so nobody new can install it. Existing installations keep working.'
          : 'It is retired: it disappears from the Store and is marked Archived. Existing installations are not removed.'
      }
      confirmLabel={deprecate ? 'Deprecate' : 'Archive'}
      destructive={!deprecate}
      pending={set.isPending}
      error={set.error}
      onConfirm={() => set.mutate({ id: entry.id, status })}
    />
  );
}

/** The summary of a publish from the list: version, who gets it, risk, and that the test passed. */
export function PublishEntryDialog({
  entry,
  open,
  onOpenChange,
}: Dialogs & { entry: CatalogEntryView }) {
  // The row turns into a published one when this returns, so the callback lives on the hook, not on the call.
  const publish = usePublishEntry(() => {
    toast.success(`${entry.displayName} v${entry.draftLabel} is in the Store`);
    onOpenChange(false);
  });
  const teams = useTeamOptions();
  const { reset } = publish;
  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  const v = entry.visibility;
  const teamNames = v.teamIds.map((id) => (teams.data ?? []).find((t) => t.id === id)?.name ?? id);
  const nobody = !v.org && v.teamIds.length === 0 && v.userIds.length === 0;
  const who = v.org
    ? 'Everyone in the organization'
    : [
        ...(teamNames.length ? [teamNames.join(', ')] : []),
        ...(v.userIds.length ? [plural(v.userIds.length, 'person')] : []),
      ].join(' and ') || 'Nobody yet';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Publish ${entry.displayName} v${entry.draftLabel ?? ''}?`}
      description="Publishing freezes this version and puts it in the Store for the people below."
      confirmLabel={`Publish v${entry.draftLabel ?? ''}`}
      pending={publish.isPending}
      confirmDisabled={nobody || !entry.draftVersionId}
      error={publish.error}
      onConfirm={() => {
        if (!entry.draftVersionId) return;
        publish.mutate({ entryId: entry.id, versionId: entry.draftVersionId, visibility: v });
      }}
    >
      <dl className="m-0 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Version</dt>
        <dd className="m-0 font-medium">{entry.draftLabel}</dd>
        <dt className="text-muted">Who gets it</dt>
        <dd className="m-0 font-medium">{who}</dd>
        <dt className="text-muted">Risk</dt>
        <dd className="m-0 font-medium capitalize">{entry.risk}</dd>
        <dt className="text-muted">Test</dt>
        <dd className="m-0 font-medium">Passed for this exact version</dd>
      </dl>
      {nobody ? (
        <p className="m-0 text-[13px] text-coral-ink">
          Nobody can see this entry yet.{' '}
          <Link to={editorPath(entry)} search={{ step: 'publish' } as never}>
            Choose who gets it in the editor
          </Link>
          , then publish.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

/** The line under a draft: whether it can be published (11.3). */
export function DraftStatusLine({ entry }: { entry: CatalogEntryView }) {
  if (entry.status !== 'draft' || !entry.draftTest) return null;
  if (entry.draftTest === 'passed') {
    return (
      <span className="inline-flex items-center gap-1 text-caption font-medium text-mint-ink">
        <CircleCheck className="size-3.5" aria-hidden="true" />
        Test passed: ready to publish
      </span>
    );
  }
  const failed = entry.draftTest === 'failed';
  return (
    <span
      className={`inline-flex items-center gap-1 text-caption font-medium ${failed ? 'text-coral-ink' : 'text-muted'}`}
    >
      {failed ? <CircleX className="size-3.5" aria-hidden="true" /> : null}
      {failed
        ? 'Needs a passing test (the last test failed)'
        : entry.draftTest === 'running'
          ? 'Test running'
          : 'Not tested yet'}
    </span>
  );
}

/** The row's primary action for a draft: Publish once a test passed, otherwise Test it. */
export function DraftPrimaryAction({ entry }: { entry: CatalogEntryView }) {
  const [open, setOpen] = React.useState(false);
  if (entry.status !== 'draft') return null;
  if (entry.draftTest === 'passed' && entry.draftVersionId) {
    return (
      <>
        <Button size="xs" onClick={() => setOpen(true)} aria-label={`Publish ${entry.displayName}`}>
          Publish
        </Button>
        <PublishEntryDialog entry={entry} open={open} onOpenChange={setOpen} />
      </>
    );
  }
  return (
    <Button
      asChild
      size="xs"
      variant="soft"
      aria-label={`Test ${entry.displayName}`}
      className="no-underline"
    >
      <Link to={editorPath(entry)} search={{ step: 'test' } as never}>
        Test it
      </Link>
    </Button>
  );
}

type Pending = 'delete' | 'deprecate' | 'archive' | null;

/** The per-row actions menu (11.1): Edit or Continue, Deprecate, Archive and Delete, by status and by role. */
export function EntryActionsMenu({ entry }: { entry: CatalogEntryView }) {
  const allowed = useCanManageEntry(entry);
  const [pending, setPending] = React.useState<Pending>(null);
  if (!allowed) return null;
  const used = entry.installations ?? 0;
  const draft = entry.status === 'draft';
  const live = entry.status === 'published';
  const close = (o: boolean) => {
    if (!o) setPending(null);
  };
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${entry.displayName}`}
            className="shrink-0"
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          {entry.status !== 'archived' ? (
            <DropdownMenuItem asChild>
              <Link to={editorPath(entry)} className="text-ink no-underline">
                {draft ? 'Continue' : 'Edit'}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {live ? (
            <DropdownMenuItem onSelect={() => setPending('deprecate')}>Deprecate</DropdownMenuItem>
          ) : null}
          {live || entry.status === 'deprecated' ? (
            <DropdownMenuItem onSelect={() => setPending('archive')}>Archive</DropdownMenuItem>
          ) : null}
          {entry.status !== 'archived' ? <DropdownMenuSeparator /> : null}
          {draft || used === 0 ? (
            <DropdownMenuItem
              onSelect={() => setPending('delete')}
              className="text-coral-ink data-[highlighted]:text-coral-ink"
            >
              Delete
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled
              title="Deprecate it to hide it from the Store, or remove the installations first"
            >
              Delete ({plural(used, 'installation')} use it)
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteEntryDialog entry={entry} open={pending === 'delete'} onOpenChange={close} />
      <StatusEntryDialog
        entry={entry}
        status="deprecated"
        open={pending === 'deprecate'}
        onOpenChange={close}
      />
      <StatusEntryDialog
        entry={entry}
        status="archived"
        open={pending === 'archive'}
        onOpenChange={close}
      />
    </>
  );
}
