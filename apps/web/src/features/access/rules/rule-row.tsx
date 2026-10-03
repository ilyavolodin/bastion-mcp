import { Check, Lock, Trash2, X } from 'lucide-react';
import {
  type Chip as ChipData,
  type RuleLookups,
  ruleScopeLabel,
  whatChips,
  whenChips,
  whoChips,
} from '@/api/views/access';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { PolicyRule } from './rule-draft';

export const EFFECT = {
  permit: { label: 'Permit', cls: 'bg-mint-soft text-mint-ink' },
  forbid: { label: 'Forbid', cls: 'bg-coral-soft text-coral-ink' },
} as const;

function Row({
  label,
  chips,
  mono,
  tone,
}: {
  label: string;
  chips: ChipData[];
  mono?: boolean;
  tone?: 'info' | 'berry';
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[42px] text-[11px] font-semibold text-muted">{label}</span>
      {chips.map((c) => (
        <span
          key={c.key}
          className={cn(
            'inline-flex h-6 items-center rounded-sm px-2 text-caption font-medium',
            tone === 'info' && 'bg-sky-soft text-sky-ink',
            tone === 'berry' && 'bg-berry-soft text-berry-ink',
            !tone && 'bg-sunken',
            mono && 'font-mono',
          )}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

export function RuleRow({
  rule,
  lookups,
  canEdit,
  onEdit,
  onDelete,
}: {
  rule: PolicyRule;
  lookups: RuleLookups;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const e = EFFECT[rule.effect];
  return (
    <li
      className={cn(
        'grid grid-cols-[76px_minmax(0,1fr)_150px] items-center gap-3.5 rounded-md border border-line p-3.5 max-md:grid-cols-1',
        !canEdit && 'bg-sunken',
        !rule.enabled && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'inline-flex h-[26px] items-center justify-center gap-1 rounded-sm text-caption font-semibold',
          e.cls,
        )}
      >
        {rule.effect === 'permit' ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <X className="size-3" aria-hidden="true" />
        )}
        {e.label}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="truncate text-label">{rule.name}</div>
        <Row label="WHO" chips={whoChips(rule.who, lookups)} tone="info" />
        <Row label="WHAT" chips={whatChips(rule.what, lookups)} mono />
        <Row label="WHEN" chips={whenChips(rule.when)} tone="berry" />
      </div>
      <div className="flex flex-col items-end gap-1.5 max-md:items-start">
        <span className="text-caption text-muted">
          {ruleScopeLabel(rule, lookups.teams)}
          {rule.enabled ? '' : ' · off'}
        </span>
        {canEdit ? (
          <span className="flex gap-1">
            <Button variant="outline" size="xs" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete rule" onClick={onDelete}>
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted">
            <Lock className="size-3" aria-hidden="true" />
            {rule.ownerTeamId ? 'Team rule' : 'Org rule'} · Admins edit
          </span>
        )}
      </div>
    </li>
  );
}
