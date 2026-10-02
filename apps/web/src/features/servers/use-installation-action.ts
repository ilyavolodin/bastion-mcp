import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useConnectInstallation } from '@/api/hooks';
import type { Installation } from '@/api/types';
import { installationAction } from '@/lib/format';

/** Runs the one next action of an installation that is not ready (Home tiles, setup banner, detail). */
export function useInstallationAction() {
  const connect = useConnectInstallation();
  const navigate = useNavigate();
  const run = (inst: Installation) => {
    const action = installationAction(inst);
    if (!action) return;
    if (action.kind === 'connect' || action.kind === 'reconnect') {
      connect.mutate(inst.id, {
        onSuccess: (res) => {
          if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
          toast.success(`${inst.displayName} is connected`);
        },
      });
      return;
    }
    void navigate({
      to: `/servers/${inst.id}`,
      search: { tab: action.kind === 'secret' ? 'connection' : 'logs' },
    } as never);
  };
  return { run, pending: connect.isPending };
}
