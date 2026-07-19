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
import { Route as SettingsRouteImport } from '@/routes/_app.settings';
import type { RouterContext } from '@/routes/__root';

// Mirrors the harness in app-settings-back.test.tsx: renders the real
// `/_app/settings` route file under a minimal router so hash navigation
// (the in-page section nav, the #add-cluster deep link) can be observed.
function renderSettingsRoute(auth: AuthState, initialEntries: string[]): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>Fleet console</div>,
  });
  const settingsRoute = SettingsRouteImport.update({
    id: '/settings',
    path: '/settings',
    getParentRoute: () => rootRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const routeTree = rootRoute.addChildren([indexRoute, settingsRoute]);
  const router = createRouter({
    routeTree,
    context: { queryClient, auth },
    history: createMemoryHistory({ initialEntries }),
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

const disabledAuth: AuthState = { authRequired: false };
const viewerAuth: AuthState = {
  authRequired: true,
  user: { id: 'u-viewer', email: 'viewer@example.com', displayName: 'Viewer', role: 'VIEWER' },
};

describe('/_app/settings page sections', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
    });
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([]);
    vi.spyOn(api.settings.auth, 'get').mockResolvedValue({ ...baseAuthConfig });
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups the panels under three labelled, anchor-linked sections', async () => {
    renderSettingsRoute(disabledAuth, ['/settings']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    const forecasting = screen.getByRole('heading', { name: 'Forecasting', level: 2 });
    const inventory = screen.getByRole('heading', { name: 'Inventory', level: 2 });
    const access = await screen.findByRole('heading', { name: 'Access', level: 2 });

    expect(forecasting.closest('section')).toHaveAttribute('id', 'section-forecasting');
    expect(inventory.closest('section')).toHaveAttribute('id', 'section-inventory');
    expect(access.closest('section')).toHaveAttribute('id', 'section-access');

    // Forecasting groups thresholds + categories; Inventory groups vCenter +
    // Add cluster; Access groups Authentication — each panel's own heading is
    // now h3 so the outline (h1 > h2 section > h3 panel) never doubles up.
    expect(
      screen.getByRole('heading', { name: 'Forecast thresholds', level: 3 }).closest('section'),
    ).toHaveAttribute('id', 'section-forecasting');
    expect(
      screen.getByRole('heading', { name: 'Categories', level: 3 }).closest('section'),
    ).toHaveAttribute('id', 'section-forecasting');
    expect(
      screen.getByRole('heading', { name: 'vCenter connections', level: 3 }).closest('section'),
    ).toHaveAttribute('id', 'section-inventory');
    expect(
      screen.getByRole('heading', { name: 'Add cluster', level: 3 }).closest('section'),
    ).toHaveAttribute('id', 'section-inventory');
    expect(
      (await screen.findByRole('heading', { name: 'Authentication', level: 3 })).closest('section'),
    ).toHaveAttribute('id', 'section-access');
  });

  it('renders in-page nav links targeting each section, including Access for an admin', async () => {
    renderSettingsRoute(disabledAuth, ['/settings']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(screen.getByRole('link', { name: 'Forecasting' })).toHaveAttribute(
      'href',
      '#section-forecasting',
    );
    expect(screen.getByRole('link', { name: 'Inventory' })).toHaveAttribute(
      'href',
      '#section-inventory',
    );
    expect(nav).toContainElement(screen.getByRole('link', { name: 'Access' }));
    expect(screen.getByRole('link', { name: 'Access' })).toHaveAttribute('href', '#section-access');
  });

  it('hides the Access section and its nav link from a VIEWER when auth is required', async () => {
    renderSettingsRoute(viewerAuth, ['/settings']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await waitFor(() => expect(api.settings.tenant.get).toHaveBeenCalled());

    expect(screen.queryByRole('heading', { name: 'Access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
  });

  it('drops the CONFIGURATION eyebrow above the h1', async () => {
    renderSettingsRoute(disabledAuth, ['/settings']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(screen.queryByText('Configuration')).not.toBeInTheDocument();
  });

  it('still deep-links #add-cluster to the Add cluster panel nested in its section', async () => {
    renderSettingsRoute(disabledAuth, ['/', '/settings#add-cluster']);
    const trigger = await screen.findByRole('button', { name: '+ Add cluster' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
