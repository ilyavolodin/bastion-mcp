import type { UseQueryResult } from '@tanstack/react-query';
import type * as React from 'react';
import { ProblemAlert } from './problem';
import { Skeleton } from './ui/skeleton';

/**
 * One place for loading, error and empty states of a query-backed region. `empty` is rendered when
 * `isEmpty(data)` is true; the empty node should be an `EmptyState` with its one next action.
 */
export function QueryBoundary<T>({
  query,
  children,
  empty,
  isEmpty,
  skeleton,
  label = 'Loading',
}: {
  query: Pick<UseQueryResult<T>, 'data' | 'isPending' | 'isError' | 'error' | 'refetch'>;
  children: (data: T) => React.ReactNode;
  empty?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
  skeleton?: React.ReactNode;
  label?: string;
}) {
  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={label}>
        {skeleton ?? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </div>
    );
  }
  if (query.isError) return <ProblemAlert error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data as T;
  if (empty && isEmpty?.(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}

export const CardsSkeleton = ({ count = 4, className = 'h-36' }: { count?: number; className?: string }) => (
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    {Array.from({ length: count }, (_, i) => (
      <Skeleton key={i} className={className} />
    ))}
  </div>
);
