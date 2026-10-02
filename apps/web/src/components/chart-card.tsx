import { Table2 } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Card, CardHeader } from './primitives';
import { Button } from './ui/button';

export type ChartTable = { columns: string[]; rows: (string | number)[][] };

/**
 * A chart panel with an accessible "view as table" toggle (18.1, WCAG 1.1.1/1.3.1): the same data as a
 * real <table> for screen readers and for exact numbers.
 */
export function ChartCard({
  title,
  legend,
  table,
  children,
  className,
  description,
  actions,
  id,
  interactive,
}: {
  title: string;
  legend?: React.ReactNode;
  table: ChartTable;
  children: React.ReactNode;
  className?: string;
  description?: string;
  actions?: React.ReactNode;
  id?: string;
  /** The content has focusable children (links): expose it as a group instead of a single image. */
  interactive?: boolean;
}) {
  const [asTable, setAsTable] = React.useState(false);
  const uid = React.useId();
  return (
    <Card
      aria-labelledby={`${uid}-title`}
      className={cn('gap-3', className)}
      {...(id ? { id } : {})}
    >
      <CardHeader
        id={`${uid}-title`}
        title={title}
        titleClassName="flex-none whitespace-nowrap"
        actions={
          <>
            {legend}
            {actions}
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
              className="text-muted"
            >
              <Table2 className="size-4" aria-hidden="true" />
              {asTable ? 'View as chart' : 'View as table'}
            </Button>
          </>
        }
      />
      {description ? <p className="sr-only">{description}</p> : null}
      {asTable ? (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col" className="border-b border-line px-2 py-2 text-overline">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={`${i}-${row[0]}`}>
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th
                        key={`${j}-${cell}`}
                        scope="row"
                        className="border-b border-line px-2 py-1.5 font-medium"
                      >
                        {cell}
                      </th>
                    ) : (
                      <td
                        key={`${j}-${cell}`}
                        className="border-b border-line px-2 py-1.5 tabular-nums"
                      >
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : interactive ? (
        <div role="group" aria-label={title}>
          {children}
        </div>
      ) : (
        <div role="img" aria-label={`${title} chart. Use "View as table" for the values.`}>
          {children}
        </div>
      )}
    </Card>
  );
}
