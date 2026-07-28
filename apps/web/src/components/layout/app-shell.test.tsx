import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';
import type { RouterContext } from '@/routes/__root';

import { AppShell, MAIN_CONTENT_ID } from './app-shell';

// The shell is a pathless layout route in the real tree (`routes/_app.tsx`), so
// it is mounted the same way here — with a child route to fill its `<Outlet>`
// and a real `/settings/forecasting` route for the topbar `Link` to resolve
// against. `authRequired: false` is the disabled-auth principal, under which
// `UserMenu` renders nothing.
function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    component: AppShell,
  });
  const indexRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/',
    component: () => <h1>Fleet console</h1>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/settings/forecasting',
    component: () => <h1>Forecasting</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([indexRoute, settingsRoute])]),
    context: { queryClient, auth: { authRequired: false } },
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('<AppShell> skip link (WCAG 2.2 §2.4.1, Level A)', () => {
  it('is the first tab stop, ahead of the sticky topbar', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Fleet console' });

    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });

  it('targets a main region that can actually take the focus', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Fleet console' });

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', MAIN_CONTENT_ID);
    // Programmatically focusable, but never a tab stop of its own.
    expect(main).toHaveAttribute('tabindex', '-1');

    const link = screen.getByRole('link', { name: 'Skip to main content' });
    expect(link).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);

    await userEvent.click(link);
    expect(main).toHaveFocus();
  });

  it('stays off-screen until it is focused', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Fleet console' });

    // jsdom computes no layout, so the off-screen/revealed contract is asserted
    // on the classes that encode it: parked above the viewport, pulled into it
    // on focus. `fixed` (not absolute) and `z-50` are what keep the revealed
    // link clear of the shell's `overflow-hidden` wrapper and the z-30 header.
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    expect(link).toHaveClass('fixed', '-top-20', 'z-50', 'focus:top-3');
  });
});
