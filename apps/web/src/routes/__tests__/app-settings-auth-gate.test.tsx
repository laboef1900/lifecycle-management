import type { AuthConfigResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';
import type { AuthState } from '@/lib/auth';
import { Route as SettingsAccessRouteImport } from '@/routes/_app.settings.access';
import { Route as SettingsForecastingRouteImport } from '@/routes/_app.settings.forecasting';
import { Route as SettingsIndexRouteImport } from '@/routes/_app.settings.index';
import { Route as SettingsInventoryRouteImport } from '@/routes/_app.settings.inventory';
import { Route as SettingsLayoutRouteImport } from '@/routes/_app.settings';
import type { RouterContext } from '@/routes/__root';

// Renders the real `/_app/settings/access` route file (not a re-implementation)
// under a minimal router built the same way TanStack Router's own codegen
// (routeTree.gen.ts) composes file routes — the pattern from
// app-settings-back.test.tsx, reused here since `beforeLoad` guards need the
// full parent chain (the layout supplies `Route.useRouteContext().auth` for
// the tab nav, and `beforeLoad` reads `context.auth` directly).
//
// #293: this used to render the single `/settings` route and assert the
// Authentication panel's render-gate (`canManageAuth`) hid/showed it. Access
// is now its own route with a `beforeLoad` redirect guard, so a non-admin
// never reaches the panel at all — the assertion moves from "is the panel in
// the DOM" to "did the router redirect away before it could mount".
function renderSettingsRoute(auth: AuthState, initialEntries: string[] = ['/settings/access']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>Fleet console</div>,
  });
  // `.update()`'s public typings don't model reassigning id/path/parent —
  // routeTree.gen.ts casts the same way (`as any`) when composing file
  // routes into the real tree, so we mirror that here.
  const settingsLayoutRoute = SettingsLayoutRouteImport.update({
    id: '/settings',
    path: '/settings',
    getParentRoute: () => rootRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const settingsIndexRoute = SettingsIndexRouteImport.update({
    id: '/',
    path: '/',
    getParentRoute: () => settingsLayoutRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const settingsForecastingRoute = SettingsForecastingRouteImport.update({
    id: '/forecasting',
    path: '/forecasting',
    getParentRoute: () => settingsLayoutRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const settingsInventoryRoute = SettingsInventoryRouteImport.update({
    id: '/inventory',
    path: '/inventory',
    getParentRoute: () => settingsLayoutRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const settingsAccessRoute = SettingsAccessRouteImport.update({
    id: '/access',
    path: '/access',
    getParentRoute: () => settingsLayoutRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const settingsRouteWithChildren = settingsLayoutRoute.addChildren([
    settingsIndexRoute,
    settingsForecastingRoute,
    settingsInventoryRoute,
    settingsAccessRoute,
  ]);
  const routeTree = rootRoute.addChildren([indexRoute, settingsRouteWithChildren]);
  const router = createRouter({
    routeTree,
    context: { queryClient, auth },
    history: createMemoryHistory({ initialEntries }),
  });

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...rendered };
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

describe('/_app/settings/access route guard (#293)', () => {
  beforeEach(() => {
    // Rendered regardless of the auth gate — mocked so the route settles
    // without unrelated network-error noise.
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
      forecastUncertaintyBandEnabled: false,
      forecastUncertaintyMinAnchors: 6,
      forecastUncertaintyBandWidth: 'p10_p90',
    });
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([]);
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([]);
    // Only actually fetched when the panel is visible, but harmless to mock
    // unconditionally.
    vi.spyOn(api.settings.auth, 'get').mockResolvedValue({ ...baseAuthConfig });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects a VIEWER away from /settings/access to Forecasting (oidc mode)', async () => {
    const { router } = renderSettingsRoute({
      authRequired: true,
      user: { id: 'u-viewer', email: 'viewer@example.com', displayName: 'Viewer', role: 'VIEWER' },
    });

    // The `beforeLoad` redirect fires before the Access route ever mounts —
    // the Authentication panel must never reach the DOM for a non-admin, not
    // merely be hidden by a render-gate.
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/forecasting'));
    expect(screen.queryByRole('heading', { name: 'Authentication' })).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Forecasting', level: 2 }),
    ).toBeInTheDocument();
  });

  it('lets an ADMIN reach /settings/access and see the Authentication panel (oidc mode)', async () => {
    const { router } = renderSettingsRoute({
      authRequired: true,
      user: { id: 'u-admin', email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' },
    });

    expect(await screen.findByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/access');
  });

  it('lets anyone reach /settings/access when auth is disabled', async () => {
    const { router } = renderSettingsRoute({ authRequired: false });

    expect(await screen.findByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/access');
    await waitFor(() => expect(api.settings.auth.get).toHaveBeenCalled());
  });
});
