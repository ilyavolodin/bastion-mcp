import type { DriftPolicy, RiskLevel } from '@/api/schema';
import { useAuth } from '@/auth/auth';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { Select } from '@/components/ui/input';
import type { StepProps } from './props';

export function SecurityStep({ draft, onChange, readOnly }: StepProps) {
  const { role } = useAuth();
  return (
    <Card aria-label="Security and limits" className="gap-4">
      <CardHeader
        title="Security and limits"
        subtitle="Guard profiles and limits are set org-wide in Settings"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="When a tool definition changes" help="Rug-pull protection (13.6)">
          {({ id }) => (
            <Select
              id={id}
              disabled={readOnly}
              value={draft.onDrift}
              onChange={(e) => onChange({ ...draft, onDrift: e.target.value as DriftPolicy })}
            >
              <option value="hideChanged">Hide changed tools until approved</option>
              <option value="block">Block the whole installation</option>
              <option value="warn">Warn only</option>
            </Select>
          )}
        </Field>
        {role === 'admin' ? (
          <Field label="Risk" help="Available to Cedar rules">
            {({ id }) => (
              <Select
                id={id}
                disabled={readOnly}
                value={draft.risk}
                onChange={(e) => onChange({ ...draft, risk: e.target.value as RiskLevel })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    </Card>
  );
}
