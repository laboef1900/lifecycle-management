import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { CommandPalette } from '@/components/command/command-palette';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { api } from '@/lib/api-client';

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

// The palette gates its Add-cluster action on admin (#223); mock the hook so
// tests control the role without a router context. Default admin; the viewer
// test flips it and `afterEach` puts it back — never rely on a reset at the end
// of a test body, which a failing assertion above it would skip.
const { useIsAdminMock } = vi.hoisted(() => ({ useIsAdminMock: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => useIsAdminMock() }));

const navigateMock = vi.fn();

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </ThemeProvider>
  );
}

describe('CommandPalette', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // `restoreAllMocks` only restores `vi.spyOn` spies — a hoisted `vi.fn`
    // keeps whatever `mockReturnValue` the last test set. Reset it and state
    // the file default explicitly so the suite is order-independent.
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(true);
    navigateMock.mockReset();
  });

  test('opens via window CustomEvent and filters cluster items', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [
        {
          id: 'c1',
          name: 'CL-Prod-Alpha',
          baselineDate: '2026-01-01',
          description: null,
          tenantId: 'default',
          metrics: [],
        } as unknown as Awaited<ReturnType<typeof api.clusters.list>>['items'][number],
        {
          id: 'c2',
          name: 'CL-Test-Beta',
          baselineDate: '2026-01-01',
          description: null,
          tenantId: 'default',
          metrics: [],
        } as unknown as Awaited<ReturnType<typeof api.clusters.list>>['items'][number],
      ],
      total: 2,
      limit: 100,
      offset: 0,
    });
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));

    const input = await screen.findByPlaceholderText(/search/i);
    await user.type(input, 'Alpha');

    await waitFor(() => {
      expect(screen.getByText('CL-Prod-Alpha')).toBeInTheDocument();
      expect(screen.queryByText('CL-Test-Beta')).not.toBeInTheDocument();
    });
  });

  test('selecting a cluster item navigates to its detail route', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [
        {
          id: 'cluster-xyz',
          name: 'CL-One',
          baselineDate: '2026-01-01',
          description: null,
          tenantId: 'default',
          metrics: [],
        } as unknown as Awaited<ReturnType<typeof api.clusters.list>>['items'][number],
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    const input = await screen.findByPlaceholderText(/search/i);
    await user.type(input, 'CL-One');
    await screen.findByText('CL-One');
    await user.keyboard('{Enter}');

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/clusters/$id',
      params: { id: 'cluster-xyz' },
    });
  });

  test('navigation group offers "Go to fleet" and "Go to settings", not the old overview/clusters split', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    await screen.findByPlaceholderText(/search/i);

    expect(screen.getByText('Go to fleet')).toBeInTheDocument();
    expect(screen.getByText('Go to settings')).toBeInTheDocument();
    expect(screen.queryByText('Go to overview')).not.toBeInTheDocument();
    expect(screen.queryByText('Go to clusters')).not.toBeInTheDocument();
  });

  test('selecting "Go to fleet" navigates to /', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    await screen.findByPlaceholderText(/search/i);
    await user.click(screen.getByText('Go to fleet'));

    expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
  });

  test('admins get an Add-cluster action deep-linked to the Settings panel (#223)', async () => {
    useIsAdminMock.mockReturnValue(true);
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    await screen.findByPlaceholderText(/search/i);
    await user.click(screen.getByText('Add cluster — Settings'));

    // The hash is what makes the label honest: /settings alone lands above the
    // fold with focus on <body>; the hash scrolls and focuses the panel.
    expect(navigateMock).toHaveBeenCalledWith({ to: '/settings', hash: 'add-cluster' });
  });

  test('the Add-cluster action names its destination, not the retired dialog (#223)', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    await screen.findByPlaceholderText(/search/i);

    expect(screen.getByText('Add cluster — Settings')).toBeInTheDocument();
    // The old label promised an in-place dialog that no longer exists.
    expect(screen.queryByText('Create cluster')).not.toBeInTheDocument();
  });

  test('the Add-cluster action is still findable by typing "create" (#223)', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    const input = await screen.findByPlaceholderText(/search/i);
    await user.type(input, 'create cluster');

    await waitFor(() => {
      expect(screen.getByText('Add cluster — Settings')).toBeInTheDocument();
    });
  });

  test('viewers do not see the Add-cluster action (#223)', async () => {
    useIsAdminMock.mockReturnValue(false);
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    await screen.findByPlaceholderText(/search/i);

    expect(screen.queryByText('Add cluster — Settings')).not.toBeInTheDocument();
    // The rest of the palette still renders — the gate is targeted.
    expect(screen.getByText('Go to settings')).toBeInTheDocument();
  });
});
