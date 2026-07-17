import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Route as ClusterDetailRouteImport } from '@/routes/_app.clusters.$id';
import type { RouterContext } from '@/routes/__root';

// The console and panel are heavy, data-fetching components (FleetConsole
// queries clusters/forecasts, ClusterPanel queries the cluster/forecast) —
// stubbed here so this test can focus purely on the route's own structural
// contract (PR review fix 3): the fleet console sits inside an `inert`
// wrapper while the modal detail panel is mounted alongside it. Renders the
// real route file (not a re-implementation), via the same `.update()` +
// `createRootRouteWithContext` pattern already established in this repo for
// `_app.settings.tsx` (see `app-settings-auth-gate.test.tsx`).
vi.mock('@/components/fleet/fleet-console', () => ({
  FleetConsole: () => <div data-testid="fleet-console-stub">console</div>,
}));
vi.mock('@/components/detail/cluster-panel', () => ({
  ClusterPanel: ({ clusterId }: { clusterId: string }) => (
    <div role="dialog" aria-modal="true" data-testid="panel-stub">
      panel for {clusterId}
    </div>
  ),
}));

function renderClusterDetailRoute(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  // `.update()`'s public typings don't model reassigning id/path/parent —
  // routeTree.gen.ts casts the same way (`as any`) when composing file
  // routes into the real tree, so we mirror that here.
  const clusterDetailRoute = ClusterDetailRouteImport.update({
    id: '/clusters/$id',
    path: '/clusters/$id',
    getParentRoute: () => rootRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const routeTree = rootRoute.addChildren([clusterDetailRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient, auth: { authRequired: false } },
    history: createMemoryHistory({ initialEntries: ['/clusters/c1'] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('/_app/clusters/$id modal panel + inert console wrapper (PR review fix 3)', () => {
  it('wraps the fleet console in an inert container while the modal panel is open', async () => {
    renderClusterDetailRoute();

    const consoleWrapper = await screen.findByTestId('console-wrapper');
    expect(consoleWrapper).toHaveAttribute('inert');
    expect(consoleWrapper).toContainElement(screen.getByTestId('fleet-console-stub'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The panel itself must sit outside the inert wrapper — inerting it too
    // would make the dialog itself unreachable.
    expect(consoleWrapper).not.toContainElement(dialog);
  });
});
