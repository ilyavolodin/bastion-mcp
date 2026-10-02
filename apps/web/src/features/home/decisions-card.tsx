import { Link } from '@tanstack/react-router';
import { useDriftReviews, useExecutableApprovals, useInstallRequests } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { AvatarStrip, Card, CardHeader } from '@/components/primitives';

function Row({
  count,
  title,
  to,
  action,
  children,
}: {
  count: number;
  title: string;
  to: string;
  action: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3.5 border-b border-line py-3 last:border-b-0">
      <span className="min-w-7 text-figure-lg">{count}</span>
      <div className="min-w-0 flex-1">
        <div className="text-label">{title}</div>
        {children}
      </div>
      <Link to={to} className="text-label text-tangerine-ink no-underline hover:text-ink">
        {action}
      </Link>
    </li>
  );
}

/** "Needs your decision": a number only because the count is the point (18.1). Admin, Manager, Auditor. */
export function DecisionsCard() {
  const { role } = useAuth();
  const canDecide = role === 'admin' || role === 'manager';
  const requests = useInstallRequests('open', canDecide);
  const drift = useDriftReviews('open', true);
  const approvals = useExecutableApprovals(role === 'admin');
  const nRequests = requests.data?.length ?? 0;
  const nDrift = drift.data?.length ?? 0;
  const nApprovals = approvals.data?.length ?? 0;
  const empty = nRequests + nDrift + nApprovals === 0;
  return (
    <Card aria-label="Needs your decision" className="min-w-0 flex-[1_1_340px] gap-1">
      <CardHeader title="Needs your decision" className="mb-2" />
      {empty ? (
        <p className="m-0 py-6 text-center text-muted">Nothing is waiting for you.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {canDecide && nRequests > 0 ? (
            <Row count={nRequests} title="Install requests" to="/registry" action="Review">
              <div className="mt-1">
                <AvatarStrip
                  size={22}
                  names={(requests.data ?? []).slice(0, 3).map((r) => r.requesterName)}
                />
              </div>
            </Row>
          ) : null}
          {nDrift > 0 ? (
            <Row
              count={nDrift}
              title="Tool definitions changed upstream"
              to="/security"
              action="Open"
            >
              {role === 'auditor' ? (
                <span className="text-caption text-muted">View only</span>
              ) : null}
            </Row>
          ) : null}
          {role === 'admin' && nApprovals > 0 ? (
            <Row
              count={nApprovals}
              title="Plugin with executable content"
              to="/plugins"
              action="Approve"
            />
          ) : null}
        </ul>
      )}
    </Card>
  );
}
