import { Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useCreateTeam, useSetMember, useTeams, useUsers } from '@/api/hooks';
import type { TeamView } from '@/api/views/access';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Field, FormError, useFormErrors } from '@/components/form';
import { AvatarStrip, Card, CardHeader, Chip } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { fieldErrors } from '@/lib/form-errors';
import { SLUG_HELP, teamFormSchema, teamToBody, useSlug } from '../forms';

function DirectoryTeamCard({ team }: { team: TeamView }) {
  const { role } = useAuth();
  const users = useUsers({});
  const setMember = useSetMember();
  const [adding, setAdding] = React.useState('');
  const canManage = role === 'admin' || role === 'manager';
  const candidates = (users.data ?? []).filter((u) => !team.members.some((m) => m.userId === u.id));
  return (
    <Card aria-label={team.name}>
      <CardHeader
        title={team.name}
        actions={
          <span className="text-caption text-muted">
            Managed by {team.managers.join(', ') || 'nobody'}
          </span>
        }
      />
      <AvatarStrip names={team.members.map((m) => m.name)} size={28} />
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {team.members.map((m) => (
          <li key={m.userId} className="inline-flex items-center gap-1">
            <Chip
              onRemove={
                canManage
                  ? () => setMember.mutate({ teamId: team.id, userId: m.userId, role: null })
                  : undefined
              }
              removeLabel={`Remove ${m.name} from ${team.name}`}
            >
              {m.name}
              {m.role === 'manager' ? ' · manager' : ''}
            </Chip>
            {canManage ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={
                  m.role === 'manager'
                    ? `Make ${m.name} a member of ${team.name}`
                    : `Make ${m.name} a manager of ${team.name}`
                }
                onClick={() =>
                  setMember.mutate(
                    {
                      teamId: team.id,
                      userId: m.userId,
                      role: m.role === 'manager' ? 'member' : 'manager',
                    },
                    {
                      onSuccess: () =>
                        toast.success(
                          m.role === 'manager'
                            ? `${m.name} is now a member of ${team.name}`
                            : `${m.name} now manages ${team.name}`,
                        ),
                    },
                  )
                }
              >
                {m.role === 'manager' ? 'Make member' : 'Make manager'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <Select
          aria-label={`Add a person to ${team.name}`}
          value={adding}
          className="h-9 text-[13px]"
          onChange={(e) => {
            setAdding('');
            if (e.target.value)
              setMember.mutate(
                { teamId: team.id, userId: e.target.value, role: 'member' },
                { onSuccess: () => toast.success('Added') },
              );
          }}
        >
          <option value="">+ Add a person</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      ) : null}
    </Card>
  );
}

/** Creates a team (`POST /teams`, Admin). `onCreated` lets another screen select the new team right away. */
export function NewTeamDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (team: { id: string; name: string }) => void;
}) {
  const create = useCreateTeam();
  const [displayName, setDisplayName] = React.useState('');
  const [idpGroup, setIdpGroup] = React.useState('');
  const url = useSlug(displayName);
  const form = useFormErrors();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New team">
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = teamFormSchema.safeParse({
              displayName,
              slug: url.slug,
              ...(idpGroup.trim() ? { idpGroup } : {}),
            });
            if (!parsed.success) return form.set(fieldErrors(parsed.error));
            form.clear();
            create.mutate(teamToBody(parsed.data), {
              onSuccess: (team) => {
                onOpenChange(false);
                setDisplayName('');
                setIdpGroup('');
                url.reset();
                toast.success('Team created');
                onCreated?.({ id: team.id, name: team.displayName });
              },
              onError: form.fromServer,
            });
          }}
        >
          <Field label="Team name" required error={form.errors.displayName}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
          </Field>
          <Field label="URL name" required help={SLUG_HELP} error={form.errors.slug}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                className="font-mono"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={url.slug}
                onChange={(e) => url.setSlug(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="IdP group"
            help="Optional. People in this group at the identity provider join the team."
            error={form.errors.idpGroup}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={idpGroup}
                onChange={(e) => setIdpGroup(e.target.value)}
              />
            )}
          </Field>
          <FormError message={form.errors.form} />
          <Button type="submit" disabled={create.isPending}>
            Create team
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamsTab() {
  const { role, me } = useAuth();
  const teams = useTeams();
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex flex-col gap-4">
      {role === 'admin' ? (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            New team
          </Button>
        </div>
      ) : null}
      <QueryBoundary
        query={teams}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No teams yet"
            action={
              role === 'admin' ? { label: 'New team', onClick: () => setOpen(true) } : undefined
            }
          />
        }
      >
        {(items) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {items
              .filter(
                (t) =>
                  role === 'admin' || me.teams.some((m) => m.id === t.id && m.role === 'manager'),
              )
              .map((t) => (
                <DirectoryTeamCard key={t.id} team={t} />
              ))}
          </div>
        )}
      </QueryBoundary>
      <NewTeamDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
