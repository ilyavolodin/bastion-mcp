import { KeyRound, Plus, Search, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import {
  useCreateServiceAccount,
  useCreateTeam,
  useDeactivateUser,
  useDeleteRoleMapping,
  useDeleteServiceAccount,
  useIdpConnections,
  useOAuthClients,
  usePatchOAuthClient,
  useRegisterOAuthClient,
  useRoleMappingRules,
  useRotateServiceAccount,
  useSaveRoleMapping,
  useServiceAccounts,
  useSetMember,
  useTeams,
  useUsers,
} from '@/api/hooks';
import {
  describeMapsTo,
  oauthName,
  oauthRegistration,
  oauthStatus,
  type TeamView,
} from '@/api/views/access';
import { useAuth } from '@/auth/auth';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Avatar, AvatarStrip, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { formatRelative } from '@/lib/format';
import {
  fieldErrors,
  type MappingForm,
  mappingFormSchema,
  mappingToBody,
  oauthClientFormSchema,
  oauthClientToBody,
  SLUG_HELP,
  serverFieldErrors,
  serviceAccountFormSchema,
  serviceAccountToBody,
  teamFormSchema,
  teamToBody,
  useSlug,
} from './forms';

const ROLE_TONE = { admin: 'warn', auditor: 'berry', member: 'ok' } as const;
const SOURCE_LABEL = { idp: 'IdP', scim: 'SCIM', manual: 'Manual' } as const;

type Errors = Record<string, string>;

/** Keeps the field errors of a failed submit: the form's own, then the server's. */
function useFormErrors() {
  const [errors, setErrors] = React.useState<Errors>({});
  return {
    errors,
    clear: () => setErrors({}),
    set: setErrors,
    fromServer: (e: Error) => {
      if (e instanceof ApiError && e.errors.length > 0) setErrors(serverFieldErrors(e.errors));
      else setErrors({ form: e.message });
    },
  };
}

function FormError({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
      {message}
    </p>
  ) : null;
}

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
                <span className="w-14 text-caption text-muted max-lg:hidden">
                  {SOURCE_LABEL[u.source]}
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

function TeamCard({ team }: { team: TeamView }) {
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
                <TeamCard key={t.id} team={t} />
              ))}
          </div>
        )}
      </QueryBoundary>
      <NewTeamDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

const EMPTY_MAPPING: MappingForm = {
  idpConnectionId: '',
  groupPattern: '',
  target: 'role',
  orgRole: 'member',
  teamId: '',
  teamRole: 'member',
  priority: '100',
};

export function RoleMappingTab() {
  const rules = useRoleMappingRules();
  const teams = useTeams();
  const idps = useIdpConnections();
  const save = useSaveRoleMapping();
  const del = useDeleteRoleMapping();
  const [open, setOpen] = React.useState(false);
  const [rule, setRule] = React.useState<MappingForm>(EMPTY_MAPPING);
  const form = useFormErrors();
  const patch = (p: Partial<MappingForm>) => setRule({ ...rule, ...p });
  return (
    <Card aria-label="IdP group mapping" className="gap-3">
      <CardHeader
        title="IdP group mapping"
        subtitle="Re-evaluated on every login and SCIM update; the lowest priority number wins"
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
            {[...items]
              .sort((a, b) => a.priority - b.priority)
              .map((r) => {
                const target = describeMapsTo(r.mapsTo, teams.data ?? []);
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-2.5 border-b border-line py-3 last:border-b-0"
                  >
                    <span className="text-overline">IdP group</span>
                    <Chip tone="info">
                      <span className="font-mono">{r.groupPattern}</span>
                    </Chip>
                    <span aria-hidden="true">→</span>
                    <span className="text-overline">{target.kind}</span>
                    <Chip>{target.label}</Chip>
                    <span className="text-caption text-muted">priority {r.priority}</span>
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete rule for ${r.groupPattern}`}
                      onClick={() => del.mutate(r.id)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
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
              const parsed = mappingFormSchema.safeParse(rule);
              if (!parsed.success) return form.set(fieldErrors(parsed.error));
              form.clear();
              save.mutate(
                { rule: mappingToBody(parsed.data) },
                {
                  onSuccess: () => {
                    setOpen(false);
                    setRule(EMPTY_MAPPING);
                    toast.success('Rule saved');
                  },
                  onError: form.fromServer,
                },
              );
            }}
          >
            <Field
              label="IdP group"
              required
              help="A regular expression that must match the whole group name, for example eng-(.*)."
              error={form.errors.groupPattern}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={rule.groupPattern}
                  onChange={(e) => patch({ groupPattern: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Identity provider"
              help="Leave on Any to match groups from every provider."
            >
              {({ id }) => (
                <Select
                  id={id}
                  value={rule.idpConnectionId}
                  onChange={(e) => patch({ idpConnectionId: e.target.value })}
                >
                  <option value="">Any provider</option>
                  {(idps.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Maps to">
                {({ id }) => (
                  <Select
                    id={id}
                    value={rule.target}
                    onChange={(e) => patch({ target: e.target.value as MappingForm['target'] })}
                  >
                    <option value="role">A role</option>
                    <option value="team">A team</option>
                    <option value="createTeam">A new team per group</option>
                  </Select>
                )}
              </Field>
              {rule.target === 'role' ? (
                <Field label="Role">
                  {({ id }) => (
                    <Select
                      id={id}
                      value={rule.orgRole}
                      onChange={(e) => patch({ orgRole: e.target.value as MappingForm['orgRole'] })}
                    >
                      <option value="admin">Admin</option>
                      <option value="auditor">Auditor</option>
                      <option value="member">Member</option>
                    </Select>
                  )}
                </Field>
              ) : (
                <>
                  {rule.target === 'team' ? (
                    <Field label="Team" error={form.errors.teamId}>
                      {({ id, describedBy, invalid }) => (
                        <Select
                          id={id}
                          aria-describedby={describedBy}
                          aria-invalid={invalid}
                          value={rule.teamId}
                          onChange={(e) => patch({ teamId: e.target.value })}
                        >
                          <option value="">Choose a team</option>
                          {(teams.data ?? []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  ) : null}
                  <Field label="Team role">
                    {({ id }) => (
                      <Select
                        id={id}
                        value={rule.teamRole}
                        onChange={(e) =>
                          patch({ teamRole: e.target.value as MappingForm['teamRole'] })
                        }
                      >
                        <option value="member">Member</option>
                        <option value="manager">Manager</option>
                      </Select>
                    )}
                  </Field>
                </>
              )}
              <Field label="Priority" error={form.errors.priority}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={100000}
                    value={rule.priority}
                    onChange={(e) => patch({ priority: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <FormError message={form.errors.form} />
            <Button type="submit" disabled={save.isPending}>
              Save rule
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** The client id and the one-time secret of a new or rotated service account credential. */
function CredentialDialog({
  credential,
  onClose,
}: {
  credential: { name: string; clientId: string; clientSecret?: string | undefined } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={credential !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Service account credentials"
        description={`Use these to sign ${credential?.name ?? 'the account'} in to Bastion.`}
      >
        {credential ? (
          <div className="flex flex-col gap-3">
            <CopyField label="Client id" value={credential.clientId} tone="sunken" mono />
            {credential.clientSecret ? (
              <>
                <CopyField
                  label="Client secret"
                  value={credential.clientSecret}
                  tone="sunken"
                  mono
                />
                <p className="m-0 text-caption text-muted">
                  Copy the secret now. Bastion stores only a hash and cannot show it again.
                </p>
              </>
            ) : (
              <p className="m-0 text-caption text-muted">
                This account signs in with its registered public keys; there is no secret.
              </p>
            )}
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ServiceAccountsTab() {
  const accounts = useServiceAccounts();
  const teams = useTeams();
  const create = useCreateServiceAccount();
  const rotate = useRotateServiceAccount();
  const del = useDeleteServiceAccount();
  const [open, setOpen] = React.useState(false);
  const [displayName, setDisplayName] = React.useState('');
  const [teamId, setTeamId] = React.useState('');
  const [authMethod, setAuthMethod] = React.useState<'client_secret_basic' | 'private_key_jwt'>(
    'client_secret_basic',
  );
  const [jwks, setJwks] = React.useState('');
  const [credential, setCredential] = React.useState<{
    name: string;
    clientId: string;
    clientSecret?: string | undefined;
  } | null>(null);
  const url = useSlug(displayName);
  const form = useFormErrors();
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? id;
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
                <span className="flex-1 font-mono text-[13px] font-medium">{a.displayName}</span>
                <Chip>{teamName(a.teamId)}</Chip>
                <span className="font-mono text-caption text-muted max-md:hidden">
                  {a.oauthClientId ?? 'no client'}
                </span>
                <Tag tone="neutral">
                  {a.authMethod === 'private_key_jwt' ? 'Public key' : 'Secret'}
                </Tag>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rotate credentials of ${a.displayName}`}
                  onClick={() =>
                    rotate.mutate(a.id, {
                      onSuccess: (r) =>
                        setCredential({
                          name: a.displayName,
                          clientId: r.clientId,
                          clientSecret: r.clientSecret,
                        }),
                    })
                  }
                >
                  <KeyRound className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${a.displayName}`}
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
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = serviceAccountFormSchema.safeParse({
                displayName,
                slug: url.slug,
                teamId,
                authMethod,
                jwks,
              });
              if (!parsed.success) return form.set(fieldErrors(parsed.error));
              form.clear();
              create.mutate(serviceAccountToBody(parsed.data), {
                onSuccess: (r) => {
                  setOpen(false);
                  setDisplayName('');
                  setJwks('');
                  url.reset();
                  setCredential({
                    name: r.displayName,
                    clientId: r.clientId,
                    clientSecret: r.clientSecret,
                  });
                  toast.success('Service account created');
                },
                onError: form.fromServer,
              });
            }}
          >
            <Field label="Name" required error={form.errors.displayName}>
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
            <Field label="Team" required error={form.errors.teamId}>
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">Choose a team</option>
                  {(teams.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Sign in with">
              {({ id }) => (
                <Select
                  id={id}
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}
                >
                  <option value="client_secret_basic">A client secret</option>
                  <option value="private_key_jwt">A signed key (private key JWT)</option>
                </Select>
              )}
            </Field>
            {authMethod === 'private_key_jwt' ? (
              <Field
                label="Public keys"
                required
                help="A JWKS document or an array of public JWKs."
                error={form.errors.jwks}
              >
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    className="font-mono"
                    rows={5}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={jwks}
                    onChange={(e) => setJwks(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
            <FormError message={form.errors.form} />
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <CredentialDialog credential={credential} onClose={() => setCredential(null)} />
    </Card>
  );
}

export function OAuthClientsTab() {
  const clients = useOAuthClients();
  const patch = usePatchOAuthClient();
  const register = useRegisterOAuthClient();
  const [open, setOpen] = React.useState(false);
  const [clientId, setClientId] = React.useState('');
  const [preApproved, setPreApproved] = React.useState(true);
  const form = useFormErrors();
  return (
    <Card aria-label="OAuth clients" className="gap-3">
      <CardHeader
        title="OAuth clients"
        subtitle="AI tools that ask to sign in to Bastion"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Register client
          </Button>
        }
      />
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
            {items.map((c) => {
              const status = oauthStatus(c);
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-label">{oauthName(c.clientId)}</div>
                    <div className="truncate font-mono text-caption text-muted">
                      {c.clientId} · {oauthRegistration(c.clientId)}
                    </div>
                  </div>
                  <Tag tone={status === 'approved' ? 'ok' : status === 'blocked' ? 'bad' : 'warn'}>
                    {status}
                  </Tag>
                  {status !== 'approved' ? (
                    <Button
                      size="xs"
                      onClick={() =>
                        patch.mutate({ id: c.id, patch: { preApproved: true, blocked: false } })
                      }
                    >
                      Approve
                    </Button>
                  ) : null}
                  {status !== 'blocked' ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => patch.mutate({ id: c.id, patch: { blocked: true } })}
                    >
                      Block
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Register an OAuth client"
          description="Decide about a client before it connects."
        >
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = oauthClientFormSchema.safeParse({
                clientId,
                preApproved,
                blocked: false,
              });
              if (!parsed.success) return form.set(fieldErrors(parsed.error));
              form.clear();
              register.mutate(oauthClientToBody(parsed.data), {
                onSuccess: () => {
                  setOpen(false);
                  setClientId('');
                  toast.success('Client registered');
                },
                onError: form.fromServer,
              });
            }}
          >
            <Field
              label="Client id"
              required
              help="The client's metadata document URL, or the id it registered with."
              error={form.errors.clientId}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-[14px]">
              <Checkbox
                checked={preApproved}
                onCheckedChange={(v) => setPreApproved(v === true)}
                aria-label="Approve this client now"
              />
              Approve this client now
            </label>
            <FormError message={form.errors.form} />
            <Button type="submit" disabled={register.isPending}>
              Register
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
