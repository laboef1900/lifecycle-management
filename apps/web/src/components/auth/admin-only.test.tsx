import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminOnly } from '@/components/auth/admin-only';
import type { AuthState } from '@/lib/auth';
import type { RouterContext } from '@/routes/__root';

/**
 * Renders AdminOnly under a minimal router whose root context supplies `auth`,
 * matching how useRouteContext({ from: '__root__' }) resolves in the real app
 * (same harness as app-settings-auth-gate.test.tsx).
 */
function renderWithAuth(auth: AuthState): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => (
      <AdminOnly fallback={<span>viewer-fallback</span>}>
        <span>admin-control</span>
      </AdminOnly>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    context: { queryClient, auth },
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const viewer: AuthState = {
  authRequired: true,
  user: { id: 'v', email: 'v@example.com', displayName: 'V', role: 'VIEWER' },
};
const admin: AuthState = {
  authRequired: true,
  user: { id: 'a', email: 'a@example.com', displayName: 'A', role: 'ADMIN' },
};

describe('AdminOnly / useIsAdmin', () => {
  it('renders children for an ADMIN', async () => {
    renderWithAuth(admin);
    expect(await screen.findByText('admin-control')).toBeInTheDocument();
    expect(screen.queryByText('viewer-fallback')).not.toBeInTheDocument();
  });

  it('renders the fallback (not the children) for a VIEWER', async () => {
    renderWithAuth(viewer);
    expect(await screen.findByText('viewer-fallback')).toBeInTheDocument();
    expect(screen.queryByText('admin-control')).not.toBeInTheDocument();
  });

  it('treats disabled mode (authRequired=false) as admin', async () => {
    renderWithAuth({ authRequired: false });
    expect(await screen.findByText('admin-control')).toBeInTheDocument();
  });
});
