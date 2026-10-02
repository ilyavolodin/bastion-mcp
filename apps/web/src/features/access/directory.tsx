import { Plus, Search, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useCreateServiceAccount,
  useCreateTeam,
  useDeactivateUser,
  useDeleteRoleMapping,
  useDeleteServiceAccount,
  useOAuthClients,
  usePatchOAuthClient,
  useRoleMappingRules,
  useSaveRoleMapping,
  useServiceAccounts,
  useSetMember,
  useTeams,
  useUsers,
} from '@/api/hooks';
import type { RoleMappingInput, Team } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Avatar, AvatarStrip, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { formatRelative } from '@/lib/format';

const ROLE_TONE = { admin: 'warn', auditor: 'berry', member: 'ok' } as const;

export function PeopleTab({ initialQuery }: { initialQuery?: string | undefined }) {
  const { role } = useAuth();
  const [q, setQ] = React.useState(initialQuery ?? '');
  const [dq, setDq] = React.useState(q);
  React.useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const users = useUsers({ q: dq });
  const deactivate = useDeactivateUser();
  return (
    <Card aria-label="People" className="gap-3">
      <CardHeader title="People" />
      <div className="flex h-11 items-center gap-2.5 rounded-md bg-sunken px-3.5">
        <Search className="size-4 text-muted" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search people"
          placeholder="Search by name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
        />
      </div>
      <QueryBoundary
        query={users}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="Nobody matches"
            action={{ label: 'Clear search', onClick: () => setQ('') }}
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((u) => (
              <li
                key={u.id}
                className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0"
              >
                <Avatar name={u.name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-label">{u.name}</div>
                  <div className="truncate text-caption text-muted">{u.email}</div>
                </div>
                <Tag tone={ROLE_TONE[u.orgRole]}>{u.orgRole}</Tag>
                <div className="flex gap-1 max-lg:hidden">
                  {u.teams.map((t) => (
                    <Chip key={t.id}>
                      {t.name}
                      {t.role === 'manager' ? ' · manager' : ''}
                    </Chip>
                  ))}
                </div>
                <span className="w-24 text-right text-caption text-muted max-md:hidden">
                  {u.lastActiveAt ? formatRelative(u.lastActiveAt) : 'never'}
                </span>
                {role === 'admin' && u.status === 'active' ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      deactivate.mutate(u.id, {
                        onSuccess: () => toast.success(`${u.name} deactivated`),
                      })
                    }
                  >
                    Deactivate
                  </Button>
                ) : u.status === 'deactivated' ? (
                  <Tag tone="neutral">Deactivated</Tag>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}

function TeamCard({ team }: { team: Team }) {
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
          <li key={m.userId}>
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

export function TeamsTab() {
  const { role, me } = useAuth();
  const teams = useTeams();
  const create = useCreateTeam();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
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
                <TeamCard key={t.id} team={t} />
              ))}
          </div>
        )}
      </QueryBoundary>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New team">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim())
                create.mutate(
                  { name: name.trim() },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setName('');
                      toast.success('Team created');
                    },
                  },
                );
            }}
          >
            <Field label="Team name" required>
              {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Button type="submit" disabled={!name.trim()}>
              Create team
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RoleMappingTab() {
  const rules = useRoleMappingRules();
  const save = useSaveRoleMapping();
  const del = useDeleteRoleMapping();
  const [open, setOpen] = React.useState(false);
  const [rule, setRule] = React.useState<RoleMappingInput>({
    idpGroup: '',
    match: 'equals',
    target: 'role',
    targetValue: 'member',
  });
  const [error, setError] = React.useState<string | undefined>();
  return (
    <Card aria-label="IdP group mapping" className="gap-3">
      <CardHeader
        title="IdP group mapping"
        subtitle="Re-evaluated on every login and SCIM update"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Add rule
          </Button>
        }
      />
      <QueryBoundary
        query={rules}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No mapping rules"
            description="Without rules, people join with the Member role and no teams."
            action={{ label: 'Add rule', onClick: () => setOpen(true) }}
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2.5 border-b border-line py-3 last:border-b-0"
              >
                <span className="text-overline">IdP group</span>
                <Chip tone="info">
                  <span className="font-mono">{r.idpGroup}</span>
                </Chip>
                <Tag>{r.match}</Tag>
                <span aria-hidden="true">→</span>
                <span className="text-overline">{r.target}</span>
                <Chip>{r.targetValue}</Chip>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete rule for ${r.idpGroup}`}
                  onClick={() => del.mutate(r.id)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New mapping rule" description="Map an IdP group to a role or a team.">
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!rule.idpGroup.trim()) return setError('Enter the IdP group');
              save.mutate(
                { rule },
                {
                  onSuccess: () => {
                    setOpen(false);
                    setError(undefined);
                    toast.success('Rule saved');
                  },
                },
              );
            }}
          >
            <Field label="IdP group" required error={error}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={rule.idpGroup}
                  onChange={(e) => setRule({ ...rule, idpGroup: e.target.value })}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Match">
                {({ id }) => (
                  <Select
                    id={id}
                    value={rule.match}
                    onChange={(e) =>
                      setRule({ ...rule, match: e.target.value as 'equals' | 'regex' })
                    }
                  >
                    <option value="equals">Equals</option>
                    <option value="regex">Regex</option>
                  </Select>
                )}
              </Field>
              <Field label="Maps to">
                {({ id }) => (
                  <Select
                    id={id}
                    value={rule.target}
                    onChange={(e) =>
                      setRule({
                        ...rule,
                        target: e.target.value as 'role' | 'team',
                        targetValue: e.target.value === 'role' ? 'member' : '',
                      })
                    }
                  >
                    <option value="role">A role</option>
                    <option value="team">A team</option>
                  </Select>
                )}
              </Field>
              <Field label={rule.target === 'role' ? 'Role' : 'Team'}>
                {({ id }) =>
                  rule.target === 'role' ? (
                    <Select
                      id={id}
                      value={rule.targetValue}
                      onChange={(e) => setRule({ ...rule, targetValue: e.target.value })}
                    >
                      <option value="admin">Admin</option>
                      <option value="auditor">Auditor</option>
                      <option value="member">Member</option>
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      value={rule.targetValue}
                      onChange={(e) => setRule({ ...rule, targetValue: e.target.value })}
                    />
                  )
                }
              </Field>
            </div>
            <Button type="submit" disabled={save.isPending}>
              Save rule
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function ServiceAccountsTab() {
  const accounts = useServiceAccounts();
  const teams = useTeams();
  const create = useCreateServiceAccount();
  const del = useDeleteServiceAccount();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [teamId, setTeamId] = React.useState('');
  return (
    <Card aria-label="Service accounts" className="gap-3">
      <CardHeader
        title="Service accounts"
        subtitle="Belong to one team; its managers administer them"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            New service account
          </Button>
        }
      />
      <QueryBoundary
        query={accounts}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No service accounts"
            description="Create one for a CI job or an agent that calls Bastion without a person."
            action={{ label: 'New service account', onClick: () => setOpen(true) }}
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <span className="flex-1 font-mono text-[13px] font-medium">{a.name}</span>
                <Chip>{a.teamName}</Chip>
                <span className="text-caption text-muted">
                  {a.credentials} {a.credentials === 1 ? 'credential' : 'credentials'}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${a.name}`}
                  onClick={() => del.mutate(a.id)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New service account">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && teamId)
                create.mutate(
                  { name: name.trim(), teamId },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setName('');
                      toast.success('Service account created');
                    },
                  },
                );
            }}
          >
            <Field label="Name" required>
              {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Team" required>
              {({ id }) => (
                <Select id={id} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">Choose a team</option>
                  {(teams.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" disabled={!name.trim() || !teamId}>
              Create
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function OAuthClientsTab() {
  const clients = useOAuthClients();
  const patch = usePatchOAuthClient();
  return (
    <Card aria-label="OAuth clients" className="gap-3">
      <CardHeader title="OAuth clients" subtitle="AI tools that ask to sign in to Bastion" />
      <QueryBoundary
        query={clients}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No clients yet"
            description="Clients appear here the first time an AI tool connects."
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-label">{c.name}</div>
                  <div className="truncate font-mono text-caption text-muted">
                    {c.clientId} · {c.registration}
                  </div>
                </div>
                <Tag
                  tone={c.status === 'approved' ? 'ok' : c.status === 'blocked' ? 'bad' : 'warn'}
                >
                  {c.status}
                </Tag>
                {c.status !== 'approved' ? (
                  <Button size="xs" onClick={() => patch.mutate({ id: c.id, status: 'approved' })}>
                    Approve
                  </Button>
                ) : null}
                {c.status !== 'blocked' ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => patch.mutate({ id: c.id, status: 'blocked' })}
                  >
                    Block
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}
