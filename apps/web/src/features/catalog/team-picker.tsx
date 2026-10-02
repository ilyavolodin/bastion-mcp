import { Plus } from 'lucide-react';
import * as React from 'react';
import { useTeamOptions } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { Button } from '@/components/ui/button';
import { NewTeamDialog } from '@/features/access/directory';

export type TeamOption = { id: string; name: string };

/**
 * Teams the person can pick in the editor: an Admin sees every team, a Manager the teams they manage (10.1). Only
 * an Admin may create a team (`teams.write`), so the "New team" action is theirs alone.
 */
export const useEditorTeams = (): { teams: TeamOption[]; canCreate: boolean; loading: boolean } => {
  const { me, role } = useAuth();
  const all = useTeamOptions();
  const managed = me.teams
    .filter((t) => t.role === 'manager')
    .map((t) => ({ id: t.id, name: t.name }));
  const teams = role === 'admin' ? (all.data ?? []) : managed;
  return { teams, canCreate: role === 'admin', loading: all.isLoading };
};

/** "New team" next to a team picker: opens the team form and hands back the created team. */
export function NewTeamButton({
  onCreated,
  label = 'New team',
}: {
  onCreated: (team: TeamOption) => void;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden="true" />
        {label}
      </Button>
      <NewTeamDialog open={open} onOpenChange={setOpen} onCreated={onCreated} />
    </>
  );
}
