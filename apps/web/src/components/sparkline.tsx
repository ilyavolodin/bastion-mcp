import { cn } from '@/lib/cn';

/** Polyline points scaled into a `w` by `h` box with `pad` px of vertical padding. */
export function sparkPoints(data: number[], w = 200, h = 36, pad = 2): string {
  if (data.length === 0) return '';
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  return data
    .map(
      (y, i) =>
        `${(i * step).toFixed(1)},${(h - pad - ((y - min) / span) * (h - pad * 2)).toFixed(1)}`,
    )
    .join(' ');
}

type Props = {
  data: number[];
  color?: string;
  height?: number;
  label: string;
  className?: string;
};

/** A tiny trend line for lists and tiles; exact values live in detail views (18.1). */
export function Sparkline({
  data,
  color = 'var(--tangerine)',
  height = 36,
  label,
  className,
}: Props) {
  if (data.length < 2) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 200 ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={cn('block', className)}
    >
      <polyline
        points={sparkPoints(data, 200, height)}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
