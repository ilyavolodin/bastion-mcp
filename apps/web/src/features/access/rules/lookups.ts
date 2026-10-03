import { useInstallations, useServiceAccounts, useTeams, useUsers } from '@/api/hooks';
import type { RuleLookups } from '@/api/views/access';

/** Everything the rule chips need to name teams, people, accounts and servers. */
export function useRuleLookups(): RuleLookups {
  const teams = useTeams();
  const users = useUsers({});
  const accounts = useServiceAccounts();
  const installs = useInstallations();
  return {
    teams: teams.data ?? [],
    users: users.data ?? [],
    serviceAccounts: (accounts.data ?? []).map((a) => ({ id: a.id, name: a.displayName })),
    installations: installs.data ?? [],
  };
}
