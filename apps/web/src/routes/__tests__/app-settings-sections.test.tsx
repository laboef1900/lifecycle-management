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

// Mirrors the harness in app-settings-back.test.tsx: renders the real
// `/_app/settings` layout route plus its real child routes under a minimal
// router so tab navigation (the sub-nav Links) and the #add-cluster deep
// link can be observed.
//
// #293: this replaces the single-route harness the pre-split version of this
// suite used — Forecasting/Inventory/Access are now separate routes rather
// than `<section>`s on one page, so the tree needs the layout plus its four
// children composed the same way `routeTree.gen.ts` does.
function renderSettingsRoute(auth: AuthState, initialEntries: string[]): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>Fleet console</div>,
  });
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

describe('/_app/settings sub-routes (#293)', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
    });
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([]);
    vi.spyOn(api.settings.auth, 'get').mockResolvedValue({ ...baseAuthConfig });
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects bare /settings to the Forecasting sub-route', async () => {
    renderSettingsRoute(disabledAuth, ['/settings']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await screen.findByRole('heading', { name: 'Forecasting', level: 2 });
  });

  // #297 review fix — Minor finding #2: pre-#293 bookmarks used
  // `/settings#section-*` as in-page table-of-contents anchors
  // (`FORECASTING_SECTION_HASH` / `INVENTORY_SECTION_HASH` /
  // `ACCESS_SECTION_HASH`, retired in `lib/anchors.ts`). Each section is now
  // its own route, so the index redirect must map the old hash onto the new
  // sub-route instead of unconditionally landing on Forecasting.
  it('maps a pre-#293 #section-inventory bookmark onto the Inventory sub-route', async () => {
    renderSettingsRoute(disabledAuth, ['/settings#section-inventory']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await screen.findByRole('heading', { name: 'Inventory', level: 2 });
  });

  it('maps a pre-#293 #section-access bookmark onto the Access sub-route', async () => {
    renderSettingsRoute(disabledAuth, ['/settings#section-access']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await screen.findByRole('heading', { name: 'Access', level: 2 });
  });

  it('maps a pre-#293 #section-forecasting bookmark onto the Forecasting sub-route', async () => {
    renderSettingsRoute(disabledAuth, ['/settings#section-forecasting']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await screen.findByRole('heading', { name: 'Forecasting', level: 2 });
  });

  // `#add-cluster` is different from the `#section-*` hashes above: it still
  // addresses a real panel *within* the Inventory sub-route (`ADD_CLUSTER_HASH`
  // is unretired), so the index redirect must carry it onto the new URL —
  // `/settings/inventory#add-cluster` — rather than dropping it.
  it('preserves a pre-#293 #add-cluster bookmark onto /settings/inventory#add-cluster', async () => {
    renderSettingsRoute(disabledAuth, ['/settings#add-cluster']);
    const trigger = await screen.findByRole('button', { name: '+ Add cluster' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('renders the tab nav linking to each sub-route, including Access for an admin', async () => {
    renderSettingsRoute(disabledAuth, ['/settings/forecasting']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const forecastingLink = screen.getByRole('link', { name: 'Forecasting' });
    const inventoryLink = screen.getByRole('link', { name: 'Inventory' });
    const accessLink = screen.getByRole('link', { name: 'Access' });

    expect(forecastingLink).toHaveAttribute('href', '/settings/forecasting');
    expect(inventoryLink).toHaveAttribute('href', '/settings/inventory');
    expect(accessLink).toHaveAttribute('href', '/settings/access');
    expect(nav).toContainElement(forecastingLink);
    expect(nav).toContainElement(inventoryLink);
    expect(nav).toContainElement(accessLink);

    // The active tab is marked for assistive tech via TanStack Router's
    // default active-link behaviour, not a synthetic ARIA tablist.
    expect(forecastingLink).toHaveAttribute('aria-current', 'page');
    expect(inventoryLink).not.toHaveAttribute('aria-current');
  });

  it('hides the Access tab from a VIEWER when auth is required', async () => {
    renderSettingsRoute(viewerAuth, ['/settings/forecasting']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await waitFor(() => expect(api.settings.tenant.get).toHaveBeenCalled());

    expect(screen.queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
  });

  it('drops the CONFIGURATION eyebrow above the h1', async () => {
    renderSettingsRoute(disabledAuth, ['/settings/forecasting']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(screen.queryByText('Configuration')).not.toBeInTheDocument();
  });

  it('renders the Forecasting sub-route with its panels under an h2', async () => {
    renderSettingsRoute(disabledAuth, ['/settings/forecasting']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    const forecasting = screen.getByRole('heading', { name: 'Forecasting', level: 2 });
    expect(
      screen.getByRole('heading', { name: 'Forecast thresholds', level: 3 }).closest('section'),
    ).toBe(forecasting.closest('section'));
    expect(screen.getByRole('heading', { name: 'Categories', level: 3 }).closest('section')).toBe(
      forecasting.closest('section'),
    );

    // Inventory/Access content is not mounted while on the Forecasting route.
    expect(screen.queryByRole('heading', { name: 'Inventory', level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'vCenter connections' })).not.toBeInTheDocument();
  });

  it('renders the Inventory sub-route with its panels under an h2', async () => {
    renderSettingsRoute(disabledAuth, ['/settings/inventory']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    const inventory = screen.getByRole('heading', { name: 'Inventory', level: 2 });
    expect(
      screen.getByRole('heading', { name: 'vCenter connections', level: 3 }).closest('section'),
    ).toBe(inventory.closest('section'));
    expect(screen.getByRole('heading', { name: 'Add cluster', level: 3 }).closest('section')).toBe(
      inventory.closest('section'),
    );

    expect(
      screen.queryByRole('heading', { name: 'Forecasting', level: 2 }),
    ).not.toBeInTheDocument();
  });

  it('renders the Access sub-route with the Authentication panel for an admin', async () => {
    renderSettingsRoute(disabledAuth, ['/settings/access']);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    const access = screen.getByRole('heading', { name: 'Access', level: 2 });
    expect(
      (await screen.findByRole('heading', { name: 'Authentication', level: 3 })).closest('section'),
    ).toBe(access.closest('section'));
  });

  it('still deep-links #add-cluster to the Add cluster panel nested in the Inventory sub-route', async () => {
    renderSettingsRoute(disabledAuth, ['/', '/settings/inventory#add-cluster']);
    const trigger = await screen.findByRole('button', { name: '+ Add cluster' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
