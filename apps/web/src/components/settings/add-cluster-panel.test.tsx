import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { AddClusterPanel } from './add-cluster-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The panel is `AdminOnly`-gated via `useIsAdmin`, which reads router context.
// Mock the hook so the panel renders in isolation and each test controls the
// role. Default admin; the VIEWER test flips it.
const { useIsAdminMock } = vi.hoisted(() => ({ useIsAdminMock: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => useIsAdminMock() }));

// The panel reads the router location to decide whether it was deep-linked
// (#223 review follow-up). Mock `useLocation` so tests drive the hash without a
// RouterProvider, honouring the `select` option the panel passes.
const { locationHashMock } = vi.hoisted(() => ({ locationHashMock: vi.fn(() => '') }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: <T,>(opts?: {
    select?: (location: { hash: string }) => T;
  }): T | { hash: string } => {
    const location = { hash: locationHashMock() };
    return opts?.select ? opts.select(location) : location;
  },
}));

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<AddClusterPanel>', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // `restoreAllMocks` does not reset a hoisted `vi.fn`; state the defaults.
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(true);
    locationHashMock.mockReset();
    locationHashMock.mockReturnValue('');
  });

  it('renders the section heading and Add cluster trigger for admins', () => {
    renderWithClient(<AddClusterPanel />);
    expect(screen.getByRole('heading', { name: 'Add cluster' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add cluster' })).toBeInTheDocument();
  });

  it('renders nothing for viewers', () => {
    useIsAdminMock.mockReturnValue(false);
    const { container } = renderWithClient(<AddClusterPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('deep link (#add-cluster)', () => {
    function trigger(): HTMLElement {
      return screen.getByRole('button', { name: '+ Add cluster' });
    }

    it('scrolls itself into view and focuses the trigger when deep-linked', () => {
      locationHashMock.mockReturnValue('add-cluster');
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderWithClient(<AddClusterPanel />);

      // Without this the palette/CTA land at the top of /settings with the
      // panel below the fold and focus on <body>.
      expect(trigger()).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({
        behavior: 'smooth',
        block: 'start',
      });
    });

    it('exposes the anchor id the deep link targets', () => {
      locationHashMock.mockReturnValue('add-cluster');
      const { container } = renderWithClient(<AddClusterPanel />);
      expect(container.querySelector('#add-cluster')).not.toBeNull();
    });

    it('scrolls instantly under prefers-reduced-motion', () => {
      locationHashMock.mockReturnValue('add-cluster');
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query === '(prefers-reduced-motion: reduce)',
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderWithClient(<AddClusterPanel />);

      expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({ behavior: 'auto' });
    });

    it('does not scroll or steal focus when the hash targets something else', () => {
      locationHashMock.mockReturnValue('vcenter-connections');
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderWithClient(<AddClusterPanel />);

      expect(trigger()).not.toHaveFocus();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('does not scroll or steal focus on a plain visit to /settings', () => {
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderWithClient(<AddClusterPanel />);

      expect(trigger()).not.toHaveFocus();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  it('opens the create-cluster dialog and creates a cluster end-to-end', async () => {
    vi.spyOn(api.clusters, 'create').mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderWithClient(<AddClusterPanel />);

    await user.click(screen.getByRole('button', { name: '+ Add cluster' }));
    const dialog = screen.getByRole('dialog', { name: 'New cluster' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'CL-Settings-1');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Consumption (GB)' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Consumption (GB)' }), '100');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Capacity (GB)' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Capacity (GB)' }), '500');
    await user.click(within(dialog).getByRole('button', { name: 'Create cluster' }));

    await waitFor(() => {
      expect(api.clusters.create).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.clusters.create).mock.calls[0]?.[0]).toMatchObject({
      name: 'CL-Settings-1',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 500 }],
    });
  });
});
