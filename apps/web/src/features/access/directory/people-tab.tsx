import { Search } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useDeactivateUser, useRoleMappingRules, useSetUserRole, useUsers } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Avatar, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { DEBOUNCE_TYPING_MS, useDebounced } from '@/hooks/use-debounced-value';
import { formatRelative } from '@/lib/format';

const ROLE_TONE = { admin: 'warn', auditor: 'berry', member: 'ok' } as const;
const SOURCE_LABEL = { idp: 'IdP', scim: 'SCIM', manual: 'Manual' } as const;

export function PeopleTab({ initialQuery }: { initialQuery?: string | undefined }) {
  const { role } = useAuth();
  const [q, setQ] = React.useState(initialQuery ?? '');
  const dq = useDebounced(q, DEBOUNCE_TYPING_MS);
  const users = useUsers({ q: dq });
  const deactivate = useDeactivateUser();
  const setRole = useSetUserRole();
  const rules = useRoleMappingRules();
  // Group rules that name a role set it again at every sign-in: a role chosen here would be replaced.
  const rulesSetRoles = (rules.data ?? []).some((r) => 'orgRole' in (r.mapsTo as object));
  const [roleError, setRoleError] = React.useState<string | undefined>();
  return (
    <Card aria-label="People" className="gap-3">
      <CardHeader title="People" />
      <p className="m-0 text-caption text-muted">
        {role === 'admin'
          ? 'Everyone who signs in through your identity provider starts as a Member. Choose a role here to make somebody an Admin or an Auditor; to make somebody a team manager, open the team.'
          : 'Roles and teams of the people in your organization.'}
        {role === 'admin' && rulesSetRoles
          ? ' IdP group mapping rules also set roles, at every sign-in, and replace a role chosen here.'
          : ''}
      </p>
      {roleError ? (
        <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
          {roleError}
        </p>
      ) : null}
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
                {role === 'admin' && u.status === 'active' ? (
                  <Select
                    aria-label={`Role of ${u.name}`}
                    value={u.orgRole}
                    className="h-9 w-28 text-[13px]"
                    onChange={(e) => {
                      setRoleError(undefined);
                      setRole.mutate(
                        { userId: u.id, orgRole: e.target.value as typeof u.orgRole },
                        {
                          onSuccess: () => toast.success(`${u.name} is now ${e.target.value}`),
                          onError: (error) =>
                            setRoleError(
                              error instanceof ApiError
                                ? (error.detail ?? error.title)
                                : 'Could not change the role',
                            ),
                        },
                      );
                    }}
                  >
                    <option value="admin">Admin</option>
                    <option value="auditor">Auditor</option>
                    <option value="member">Member</option>
                  </Select>
                ) : (
                  <Tag tone={ROLE_TONE[u.orgRole]}>{u.orgRole}</Tag>
                )}
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
