import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { STALE_DEFAULT_MS } from '@/api/timing';
import { AuthProvider } from '@/auth/auth';
import { createAppRouter } from './router';

const friendly = (e: unknown): string => {
  if (e instanceof ApiError) return e.detail ? `${e.title}. ${e.detail}` : e.title;
  return e instanceof Error ? e.message : 'Something went wrong';
};

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_DEFAULT_MS,
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache(),
    // Failed writes are shown as a problem toast; screens may add inline detail on top.
    mutationCache: new MutationCache({
      onError: (error, _v, _c, mutation) => {
        if (mutation.meta?.silent) return;
        toast.error(friendly(error));
      },
    }),
  });

export function App({ queryClient }: { queryClient?: QueryClient }) {
  const client = React.useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  const router = React.useMemo(() => createAppRouter(client), [client]);
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
