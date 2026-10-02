import * as React from 'react';
import { useTeamOptions } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
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

/** Value of the "New team…" entry that team pickers show to Admins (one entry point, no extra buttons). */
export const NEW_TEAM_VALUE = '__new_team__';
export const NEW_TEAM_LABEL = 'New team…';

/**
 * The create-team form behind the "New team…" entry of a picker: `open()` shows it, `dialog` must be rendered once
 * next to the picker, and `onCreated` receives the created team.
 */
export function useNewTeamDialog(onCreated: (team: TeamOption) => void): {
  open: () => void;
  dialog: React.ReactNode;
} {
  const [isOpen, setOpen] = React.useState(false);
  return {
    open: () => setOpen(true),
    dialog: <NewTeamDialog open={isOpen} onOpenChange={setOpen} onCreated={onCreated} />,
  };
}
