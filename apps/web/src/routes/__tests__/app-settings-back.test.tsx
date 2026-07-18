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
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';
import type { AuthState } from '@/lib/auth';
import { Route as SettingsRouteImport } from '@/routes/_app.settings';
import type { RouterContext } from '@/routes/__root';

// Renders the real `/_app/settings` route file under a minimal two-route
// memory router (an index `/` plus `/settings`) so the Back button's real
// navigation — history-pop when there's a prior entry, `/` fallback otherwise —
// can be observed on `router.state.location.pathname`. Mirrors the harness in
// app-settings-auth-gate.test.tsx, extended with a real `/` route and a
// configurable history so the fallback vs history-back branch is exercised.
function renderSettingsRoute(auth: AuthState, initialEntries: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>Fleet console</div>,
  });
  // `.update()`'s public typings don't model reassigning id/path/parent —
  // routeTree.gen.ts casts the same way (`as any`) when composing file routes.
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

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

const baseAuthConfig: AuthConfigResponse = {
  mode: 'disabled',
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

describe('/_app/settings Back button + Esc', () => {
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

  it('clicking Back pops history to the previous route', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('falls back to / when Settings was the entry point (no history to pop)', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('Esc triggers Back (document-level listener fires with focus on body)', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('Esc is suppressed while a dismissible overlay is open', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    // Simulate a portaled Radix overlay (e.g. the vCenter remove ConfirmDialog)
    // being open — it renders with role="dialog" on document.body. The guard
    // must let that overlay handle Escape instead of navigating the page away.
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.appendChild(overlay);
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Give any (incorrect) navigation a chance to settle before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(router.state.location.pathname).toBe('/settings');
    } finally {
      document.body.removeChild(overlay);
    }
  });

  it('Esc is ignored while typing in a form field', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      await userEvent.keyboard('{Escape}');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(router.state.location.pathname).toBe('/settings');
    } finally {
      document.body.removeChild(input);
    }
  });
});
