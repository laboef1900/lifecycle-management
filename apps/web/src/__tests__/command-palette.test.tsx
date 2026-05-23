import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

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
  test('opens via window CustomEvent and filters cluster items', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue([
      {
        id: 'c1',
        name: 'CL-Prod-Alpha',
        baselineDate: '2026-01-01',
        description: null,
        tenantId: 'default',
        metrics: [],
      } as unknown as Awaited<ReturnType<typeof api.clusters.list>>[number],
      {
        id: 'c2',
        name: 'CL-Test-Beta',
        baselineDate: '2026-01-01',
        description: null,
        tenantId: 'default',
        metrics: [],
      } as unknown as Awaited<ReturnType<typeof api.clusters.list>>[number],
    ]);
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
    vi.spyOn(api.clusters, 'list').mockResolvedValue([
      {
        id: 'cluster-xyz',
        name: 'CL-One',
        baselineDate: '2026-01-01',
        description: null,
        tenantId: 'default',
        metrics: [],
      } as unknown as Awaited<ReturnType<typeof api.clusters.list>>[number],
    ]);
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
});
