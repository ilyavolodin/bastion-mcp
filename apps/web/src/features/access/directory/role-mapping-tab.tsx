import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useDeleteRoleMapping,
  useIdpConnections,
  useRoleMappingRules,
  useSaveRoleMapping,
  useTeams,
} from '@/api/hooks';
import { describeMapsTo } from '@/api/views/access';
import { EmptyState } from '@/components/empty-state';
import { Field, FormError, useFormErrors } from '@/components/form';
import { Card, CardHeader, Chip } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { fieldErrors } from '@/lib/form-errors';
import { type MappingForm, mappingFormSchema, mappingToBody } from '../forms';

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
