import type { HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { DecommissionHostDialog } from './decommission-host-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-1',
    name: 'esx-01',
    description: null,
    commissionedAt: '2025-06-01',
    decommissionedAt: null,
    serialNumber: null,
    vendor: null,
    model: null,
    purchasedAt: null,
    warrantyEndsAt: null,
    eolAt: null,
    runPastEol: false,
    state: 'in_service',
    projectedDecommissionAt: null,
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    capacities: [],
    ...overrides,
  };
}

function renderDialog(host: HostResponse = makeHost()): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DecommissionHostDialog open onOpenChange={vi.fn()} clusterId="cl-1" host={host} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<DecommissionHostDialog>', () => {
  it("shows the dialog's own error for a blank date, focuses the field, and sends nothing", async () => {
    const update = vi.spyOn(api.hosts, 'update').mockResolvedValue(makeHost());
    const user = userEvent.setup();
    renderDialog();

    const date = screen.getByLabelText(/decommissioned at/i);
    await user.clear(date);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // The app's own error, not the browser's transient bubble.
    expect(
      await screen.findByText(/pick the date this host stops contributing capacity/i),
    ).toBeInTheDocument();
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(date).toHaveAccessibleDescription(
      /pick the date this host stops contributing capacity/i,
    );
    // SC 3.3.1 — the user lands on the field that needs fixing.
    expect(date).toHaveFocus();
    // The whole point of building this path before switching `noValidate` on:
    // an invalid date must not reach the API.
    expect(update).not.toHaveBeenCalled();
  });

  it('submits the chosen date once it is valid', async () => {
    const update = vi.spyOn(api.hosts, 'update').mockResolvedValue(makeHost());
    const user = userEvent.setup();
    renderDialog();

    const date = screen.getByLabelText(/decommissioned at/i);
    await user.clear(date);
    await user.type(date, '2026-09-30');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('host-1', { decommissionedAt: '2026-09-30' }),
    );
  });

  it('clears the decommission date without demanding one', async () => {
    const update = vi.spyOn(api.hosts, 'update').mockResolvedValue(makeHost());
    const user = userEvent.setup();
    renderDialog(makeHost({ decommissionedAt: '2026-01-31' }));

    const date = screen.getByLabelText(/decommissioned at/i);
    await user.clear(date);
    await user.click(screen.getByRole('button', { name: /clear decommission/i }));

    // Clearing asks for no date, so the required-date gate must not block it.
    await waitFor(() => expect(update).toHaveBeenCalledWith('host-1', { decommissionedAt: null }));
    expect(
      screen.queryByText(/pick the date this host stops contributing capacity/i),
    ).not.toBeInTheDocument();
  });
});
