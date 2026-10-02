import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/** A filter chip that is a real <select>: keyboard and screen-reader behaviour for free. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel = 'any',
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** Text of the empty option; omit with `anyLabel={null}` for always-set filters (time range). */
  anyLabel?: string | null;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'relative inline-flex h-10 items-center rounded-md border border-line bg-surface text-[13px] font-medium text-ink',
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full appearance-none rounded-md bg-transparent pl-3.5 pr-9 text-[13px] font-medium text-ink"
      >
        {anyLabel !== null ? <option value="">{`${label}: ${anyLabel}`}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {anyLabel !== null ? `${label}: ${o.label}` : o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 size-3.5 text-muted"
        aria-hidden="true"
      />
    </label>
  );
}
