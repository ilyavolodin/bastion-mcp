import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter } from '@tanstack/react-router';
import * as React from 'react';
import { Guard } from '@/components/role-gate';
import { EmptyState } from '@/components/empty-state';
import { AppShell } from '@/components/shell/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import type { NavSection } from '@/lib/roles';

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
  notFoundComponent: () => (
    <EmptyState
      icon={<span aria-hidden="true">?</span>}
      title="That page does not exist"
      description="The link may be old, or it may not be in your navigation."
      action={{ label: 'Back to Home', to: '/' }}
      headingLevel={1}
    />
  ),
});

type PageLoader = () => Promise<Record<string, unknown>>;

/** A lazily loaded screen wrapped in its role guard (18.2). */
const PageFallback = () => (
  <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
    <Skeleton className="h-9 w-48" />
    <Skeleton className="h-40 w-full" />
  </div>
);

const screen = (path: string, section: NavSection, loader: PageLoader, exportName: string) => {
  const Lazy = React.lazy(async () => {
    const mod = await loader();
    return { default: mod[exportName] as React.ComponentType };
  });
  const Guarded = () => (
    <Guard section={section}>
      <React.Suspense fallback={<PageFallback />}>
        <Lazy />
      </React.Suspense>
    </Guard>
  );
  return createRoute({ getParentRoute: () => root, path, component: Guarded });
};

export const routeTree = root.addChildren([
  screen('/', 'home', () => import('@/features/home/home-page'), 'HomePage'),
  screen('/store', 'store', () => import('@/features/store/store-page'), 'StorePage'),
  screen('/servers', 'servers', () => import('@/features/servers/servers-page'), 'ServersPage'),
  screen('/servers/$id', 'servers', () => import('@/features/servers/installation-page'), 'InstallationPage'),
  screen('/activity', 'activity', () => import('@/features/activity/activity-page'), 'ActivityPage'),
  screen('/observability', 'observability', () => import('@/features/observability/observability-page'), 'ObservabilityPage'),
  screen('/security', 'security', () => import('@/features/security/security-page'), 'SecurityPage'),
  screen('/catalog', 'catalog', () => import('@/features/catalog/catalog-page'), 'CatalogPage'),
  screen('/catalog/$id', 'catalog', () => import('@/features/catalog/editor-page'), 'CatalogEditorPage'),
  screen('/registry', 'registry', () => import('@/features/registry/registry-page'), 'RegistryPage'),
  screen('/access', 'access', () => import('@/features/access/access-page'), 'AccessPage'),
  screen('/settings', 'settings', () => import('@/features/settings/settings-page'), 'SettingsPage'),
  screen('/plugins', 'plugins', () => import('@/features/plugins/plugins-page'), 'PluginsPage'),
  screen('/plugins/marketplace/$id', 'plugins', () => import('@/features/plugins/marketplace-page'), 'MarketplacePage'),
  screen('/plugins/edit/$id', 'plugins', () => import('@/features/plugins/plugin-editor-page'), 'PluginEditorPage'),
]);

export const createAppRouter = (queryClient: QueryClient, history?: Parameters<typeof createRouter>[0]['history']) =>
  createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    ...(history ? { history } : {}),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;
