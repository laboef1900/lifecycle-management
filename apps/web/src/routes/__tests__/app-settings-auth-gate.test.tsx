import type { AuthConfigResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';
import type { AuthState } from '@/lib/auth';
import { Route as SettingsRouteImport } from '@/routes/_app.settings';
import type { RouterContext } from '@/routes/__root';

// Renders the real `/_app/settings` route file (not a re-implementation)
// under a minimal router built the same way TanStack Router's own
// codegen (routeTree.gen.ts) composes file routes: `.update()` the
// imported Route with an id/path/parent, then attach it under a
// `createRootRouteWithContext` root that supplies `auth` — the pattern
// from apps/web/src/__tests__/keyboard-shortcuts.test.tsx, extended with
// router context since `_app.settings.tsx`'s gate reads
// `Route.useRouteContext().auth`.
function renderSettingsRoute(auth: AuthState): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  // `.update()`'s public typings don't model reassigning id/path/parent —
  // routeTree.gen.ts casts the same way (`as any`) when composing file
  // routes into the real tree, so we mirror that here.
  const settingsRoute = SettingsRouteImport.update({
    id: '/settings',
    path: '/settings',
    getParentRoute: () => rootRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const routeTree = rootRoute.addChildren([settingsRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient, auth },
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const baseAuthConfig: AuthConfigResponse = {
  mode: 'disabled',
  forceDisabledReason: null,
  issuerUrl: null,
  clientId: null,
  appBaseUrl: null,
  scopes: 'openid profile email',
  roleClaim: null,
  adminValues: null,
  defaultRole: 'admin',
  allowedEmailDomains: null,
  allowedEmails: null,
  sessionTtlHours: 12,
  allowInsecure: false,
  clientSecretSet: false,
  signingSecretSet: false,
  redirectUri: 'https://app.example.com/api/auth/callback',
  discoveryStatus: 'disabled',
  lastDiscoveryError: null,
};

describe('/_app/settings admin-only Authentication panel gate', () => {
  beforeEach(() => {
    // Rendered regardless of the auth gate — mocked so the route settles
    // without unrelated network-error noise.
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
    });
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([]);
    // Only actually fetched when the panel is visible, but harmless to mock
    // unconditionally.
    vi.spyOn(api.settings.auth, 'get').mockResolvedValue({ ...baseAuthConfig });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides the Authentication panel from a VIEWER when auth is required (oidc mode)', async () => {
    renderSettingsRoute({
      authRequired: true,
      user: { id: 'u-viewer', email: 'viewer@example.com', displayName: 'Viewer', role: 'VIEWER' },
    });

    // Prove the route actually rendered before asserting on absence.
    await screen.findByText(/forecast thresholds/i);
    expect(screen.queryByRole('heading', { name: 'Authentication' })).not.toBeInTheDocument();
  });

  it('shows the Authentication panel to an ADMIN when auth is required (oidc mode)', async () => {
    renderSettingsRoute({
      authRequired: true,
      user: { id: 'u-admin', email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' },
    });

    expect(await screen.findByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
  });

  it('shows the Authentication panel to anyone when auth is disabled', async () => {
    renderSettingsRoute({ authRequired: false });

    expect(await screen.findByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
    await waitFor(() => expect(api.settings.auth.get).toHaveBeenCalled());
  });
});
