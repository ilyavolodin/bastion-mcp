import { useAuth } from '@/auth/auth';
import { PageHeader } from '@/components/page-header';
import { ACTIVITY_SCOPE } from '@/lib/roles';
import { CallExplorer } from './call-explorer';

export function ActivityPage() {
  const { role } = useAuth();
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every call through Bastion, with the reason it was allowed or stopped."
        actions={
          <div className="flex items-center gap-2.5 rounded-lg bg-surface px-3.5 py-2 shadow-card">
            <span className="text-caption text-muted">Showing</span>
            <span className="text-figure-sm">{ACTIVITY_SCOPE[role].header}</span>
          </div>
        }
      />
      <CallExplorer />
    </>
  );
}
