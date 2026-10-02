import { useNavigate } from '@tanstack/react-router';
import { useConnectInstallation } from '@/api/hooks';
import type { InstallationView } from '@/api/views/servers';
import { installationAction } from '@/lib/format';

/** The upstream sign-in opens in its own tab; the API sends that tab back to `returnTo` when it is done. */
export const openAuthorization = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

/** Runs the one next action of an installation that is not ready (Home tiles, setup banner, detail). */
export function useInstallationAction() {
  const connect = useConnectInstallation();
  const navigate = useNavigate();
  const run = (inst: Pick<InstallationView, 'id' | 'status' | 'authMode' | 'displayName'>) => {
    const action = installationAction(inst);
    if (!action) return;
    if (action.kind === 'connect' || action.kind === 'reconnect') {
      connect.mutate(
        { id: inst.id, returnTo: `/servers/${inst.id}?tab=connection` },
        { onSuccess: (res) => openAuthorization(res.authorizationUrl) },
      );
      return;
    }
    void navigate({
      to: `/servers/${inst.id}`,
      search: { tab: action.kind === 'secret' ? 'connection' : 'logs' },
    } as never);
  };
  return { run, pending: connect.isPending };
}
