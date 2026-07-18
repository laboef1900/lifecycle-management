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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, unmount };
}

/** An untrusted Escape as it arrives at the document listener. */
function escapeEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
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

  it('ignores an Escape a nearer handler already consumed (defaultPrevented)', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    // Neither a typing target nor an overlay, so `defaultPrevented` is the only
    // guard that can stop this Escape — it pins the ordering contract that lets
    // any nearer handler consume Escape before the page acts on it.
    const consumer = document.createElement('div');
    consumer.addEventListener('keydown', (event) => event.preventDefault());
    document.body.appendChild(consumer);
    try {
      consumer.dispatchEvent(escapeEvent());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(router.state.location.pathname).toBe('/settings');
    } finally {
      document.body.removeChild(consumer);
    }
  });

  it('ignores OS auto-repeat Escape keydowns (holding Esc is one intent)', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });
    const back = vi.spyOn(router.history, 'back');

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        repeat: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('removes the document listener on unmount (no stray Esc navigation)', async () => {
    // Handler *identity* is half the assertion, deliberately: a behaviour-only
    // probe is vacuous here. If the cleanup regresses, every earlier test in
    // this file leaks a listener too, and the first of those `preventDefault()`s
    // the probe Escape — so this test's own leaked handler would bail on the
    // `defaultPrevented` guard and the spy would stay clean. Two defences:
    // capture what was registered and require it back at removeEventListener,
    // and dispatch a *non-cancelable* Escape below so no leaked handler can
    // mask this one.
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { router, unmount } = renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    const registered = addSpy.mock.calls
      .filter(([type]) => type === 'keydown')
      .map(([, listener]) => listener);
    expect(registered).toHaveLength(1);

    // Asserted on the history spy, not on `router.state`: once RouterProvider
    // unmounts, nothing subscribes the router to the history, so a leaked pop
    // would move the history without ever showing up in `state.location`.
    const back = vi.spyOn(router.history, 'back');

    // A leaked document-level listener is this design's highest-blast-radius
    // regression: Esc would keep popping history from anywhere in the app.
    unmount();

    const unregistered = removeSpy.mock.calls
      .filter(([type]) => type === 'keydown')
      .map(([, listener]) => listener);
    for (const listener of registered) {
      expect(unregistered).toContain(listener);
    }

    // `cancelable: false` makes `preventDefault()` a no-op, so a leaked handler
    // from any sibling test cannot swallow this probe before it reaches a
    // (hypothetically) leaked handler of our own.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back).not.toHaveBeenCalled();
  });

  it('pops exactly one history entry when Escape is pressed twice in a row', async () => {
    // Three entries so an over-pop is observable: index 2 → back → '/' (1),
    // → back again → '/settings' (0).
    const { router } = renderSettingsRoute(disabledAuth, ['/settings', '/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });
    const back = vi.spyOn(router.history, 'back');

    // Both in the same task: in a real browser `history.back()` only lands on a
    // later popstate task, so the page — and this listener — is still mounted
    // with a stale `canGoBack` when the second Escape arrives.
    document.dispatchEvent(escapeEvent());
    document.dispatchEvent(escapeEvent());

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(back).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.state.location.pathname).toBe('/');
  });

  it('navigates once when Back is double-clicked', async () => {
    const { router } = renderSettingsRoute(disabledAuth, ['/settings', '/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });
    const back = vi.spyOn(router.history, 'back');
    const button = screen.getByRole('button', { name: 'Back' });

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(back).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.state.location.pathname).toBe('/');
  });

  it('recovers after a pop that lands on the same page (hash variant)', async () => {
    // The ⌘K "Add cluster" action navigates to `/settings#add-cluster` while the
    // user may already be on `/settings`, so Back/Esc pops to `/settings` — the
    // SAME route, which does not remount. A latch that never released would stay
    // set for the rest of the visit and kill Back and Esc silently, with no
    // recovery short of a reload.
    const { router } = renderSettingsRoute(disabledAuth, [
      '/',
      '/settings',
      '/settings#add-cluster',
    ]);
    const heading = await screen.findByRole('heading', { name: 'Settings' });

    document.dispatchEvent(escapeEvent());
    await waitFor(() => expect(router.state.location.href).toBe('/settings'));

    // Same DOM node ⇒ the route component never remounted, so releasing the
    // latch is the only thing that can make the second Escape work. Without
    // this assertion the test would pass vacuously if the router ever started
    // remounting on hash changes.
    expect(screen.getByRole('heading', { name: 'Settings' })).toBe(heading);

    document.dispatchEvent(escapeEvent());
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('stays latched for a second Escape in the same task on a hash variant', async () => {
    // Guards the release added above: two Escapes in the same task both fire
    // from `/settings#add-cluster`, so the second must still be latched out.
    // An over-eager release (e.g. keying only on pathname, or resetting on any
    // location change) would let this pop twice and land on `/`.
    //
    // Scope, deliberately: this covers the same-task window only. Once the pop
    // has landed on `/settings`, the latch has released by design and a further
    // activation pops again — bounded by `canGoBack`, so the worst case is
    // landing on `/`, never leaving the SPA. See the @ai-warning in the route.
    const { router } = renderSettingsRoute(disabledAuth, [
      '/',
      '/settings',
      '/settings#add-cluster',
    ]);
    await screen.findByRole('heading', { name: 'Settings' });
    const back = vi.spyOn(router.history, 'back');

    document.dispatchEvent(escapeEvent());
    document.dispatchEvent(escapeEvent());

    await waitFor(() => expect(router.state.location.href).toBe('/settings'));
    expect(back).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.state.location.href).toBe('/settings');
  });

  it('stays latched while leaving the page, even though it renders once more', async () => {
    // Window (2) in the latch's @ai-warning, and the reason a plain "reset on
    // location change" is wrong: once the pop lands on a different pathname this
    // page renders once more before React unmounts it, so both controls are
    // still live while the location no longer matches the one they fired from.
    // Also pins that the latch is shared across the two controls (Back, then
    // Esc) rather than being per-control. Three entries make an over-pop
    // observable: index 2 → back → '/' (1) → back again → '/settings' (0).
    const { router } = renderSettingsRoute(disabledAuth, ['/settings', '/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });
    const back = vi.spyOn(router.history, 'back');
    const button = screen.getByRole('button', { name: 'Back' });

    fireEvent.click(button);

    // The window is real, not hypothetical — assert it rather than assume it.
    // If either of these ever stops holding, the assertion below would pass for
    // the wrong reason (nothing mounted to receive the second activation).
    expect(router.state.location.pathname).toBe('/');
    expect(button).toBeInTheDocument();

    document.dispatchEvent(escapeEvent());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/');
  });

  it('exposes the Esc shortcut to assistive tech without polluting the name', async () => {
    renderSettingsRoute(disabledAuth, ['/', '/settings']);
    await screen.findByRole('heading', { name: 'Settings' });

    // The visual `Esc` hint is aria-hidden, so `aria-keyshortcuts` is the only
    // channel that announces the binding — and it must not join the name.
    const button = screen.getByRole('button', { name: 'Back' });
    expect(button).toHaveAccessibleName('Back');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Escape');
  });
});
