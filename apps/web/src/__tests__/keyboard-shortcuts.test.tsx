import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';

import { KeyboardShortcuts } from '@/components/command/keyboard-shortcuts';
import { ThemeProvider } from '@/components/theme/theme-provider';

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <KeyboardShortcuts />
        <div data-testid="here" />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="dashboard">Dashboard</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div data-testid="settings">Settings</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, settingsRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

function wrap(router: ReturnType<typeof buildRouter>): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

describe('KeyboardShortcuts (real router context)', () => {
  test('g s navigates to /settings', async () => {
    const user = userEvent.setup();
    const router = buildRouter();
    render(wrap(router));

    await user.keyboard('g');
    await user.keyboard('s');

    // Allow router to flush state
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe('/settings');
  });

  test('g d navigates to /', async () => {
    const user = userEvent.setup();
    const router = buildRouter();
    render(wrap(router));

    // Start somewhere else to make the assertion meaningful
    await router.navigate({ to: '/settings' });

    await user.keyboard('g');
    await user.keyboard('d');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe('/');
  });
});
