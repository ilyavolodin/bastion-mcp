import type * as React from 'react';
import { ResponsiveContainer } from 'recharts';

/** Shared Recharts styling: Zest tokens only, so both themes work. */
export const AXIS_TICK = { fill: 'var(--ink-muted)', fontSize: 12 } as const;
export const GRID = 'var(--chart-grid)';

/**
 * Responsive container with an initial size so charts also render where layout is unavailable (tests,
 * first paint). Charts are decorative to assistive tech; the table toggle in ChartCard carries the data.
 */
export function AutoSize({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 640, height }}>
      {children}
    </ResponsiveContainer>
  );
}

type TooltipEntry = {
  name?: string | number;
  value?: string | number;
  color?: string;
  dataKey?: string | number;
};

/** Tooltip card in the Zest style (radius-lg, shadow-float). */
export function ChartTooltip({
  active,
  payload,
  label,
  format,
  labelFormat,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  format?: (v: string | number, name: string) => string;
  labelFormat?: (l: string | number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-surface px-3 py-2 text-caption shadow-float">
      {label !== undefined ? (
        <div className="mb-1 font-semibold text-ink">
          {labelFormat ? labelFormat(label) : String(label)}
        </div>
      ) : null}
      {payload.map((p) => (
        <div key={String(p.dataKey ?? p.name)} className="flex items-center gap-2 text-muted">
          <span
            className="size-2 rounded-full"
            style={{ background: p.color }}
            aria-hidden="true"
          />
          <span>{p.name}</span>
          <span className="ml-auto font-semibold tabular-nums text-ink">
            {format ? format(p.value ?? '', String(p.name ?? '')) : String(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export const hourLabel = (iso: string | number): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
};
export const dayLabel = (iso: string | number): string =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });
export const dateLabel = (iso: string | number): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
