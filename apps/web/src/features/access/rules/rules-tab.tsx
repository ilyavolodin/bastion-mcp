import * as React from 'react';
import { toast } from 'sonner';
import { useDeletePolicyRule, usePolicyRules } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Card, CardHeader } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { useRuleLookups } from './lookups';
import { RuleDialog } from './rule-dialog';
import type { PolicyRule } from './rule-draft';
import { RuleRow } from './rule-row';
import { Simulator } from './simulator';

export function RulesTab() {
  const { role } = useAuth();
  const rules = usePolicyRules();
  const del = useDeletePolicyRule();
  const lookups = useRuleLookups();
  const [editing, setEditing] = React.useState<PolicyRule | 'new' | null>(null);
  // Writing rules needs `policies.write` on the org: admins only (10.1).
  const canEdit = role === 'admin';
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <Card aria-label="Tool rules" className="gap-3">
        <CardHeader
          title="Tool rules"
          subtitle="Forbid always wins"
          actions={
            canEdit ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                Add rule
              </Button>
            ) : null
          }
        />
        <QueryBoundary
          query={rules}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              title="No tool rules"
              description="By default every installed tool is allowed. Add a rule to change that."
              action={canEdit ? { label: 'Add rule', onClick: () => setEditing('new') } : undefined}
            />
          }
        >
          {(items) => (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {[...items]
                .sort((a, b) => a.priority - b.priority)
                .map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    lookups={lookups}
                    canEdit={canEdit}
                    onEdit={() => setEditing(r)}
                    onDelete={() =>
                      del.mutate(r.id, { onSuccess: () => toast.success('Rule removed') })
                    }
                  />
                ))}
            </ul>
          )}
        </QueryBoundary>
      </Card>
      {canEdit ? <Simulator /> : null}
      <RuleDialog
        rule={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  );
}
