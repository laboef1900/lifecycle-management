import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { EndItemDialog } from './end-item-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function makeItem(overrides: Partial<ItemResponse> = {}): ItemResponse {
  return {
    id: 'app-1',
    clusterId: 'cl-1',
    kind: 'application',
    name: 'openshift-lab',
    category: 'OpenShift',
    description: null,
    effectiveDate: '2026-01-15',
    endedAt: null,
    metricTypeKey: null,
    consumptionDelta: null,
    capacityDelta: null,
    allocations: [],
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function renderDialog(item: ItemResponse = makeItem()): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EndItemDialog open onOpenChange={vi.fn()} clusterId="cl-1" item={item} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<EndItemDialog>', () => {
  it("shows the dialog's own error for a blank date, focuses the field, and sends nothing", async () => {
    const update = vi.spyOn(api.items, 'update').mockResolvedValue(makeItem());
    const user = userEvent.setup();
    renderDialog();

    const date = screen.getByLabelText(/ended at/i);
    await user.clear(date);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(
      await screen.findByText(/pick the date this allocation stops contributing/i),
    ).toBeInTheDocument();
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(date).toHaveAccessibleDescription(/pick the date this allocation stops contributing/i);
    // SC 3.3.1 — focus lands on the field that needs fixing.
    expect(date).toHaveFocus();
    expect(update).not.toHaveBeenCalled();
  });

  it('submits the chosen date once it is valid', async () => {
    const update = vi.spyOn(api.items, 'update').mockResolvedValue(makeItem());
    const user = userEvent.setup();
    renderDialog();

    const date = screen.getByLabelText(/ended at/i);
    await user.clear(date);
    await user.type(date, '2026-11-30');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('app-1', { endedAt: '2026-11-30' }));
  });

  it('clears the end date without demanding one', async () => {
    const update = vi.spyOn(api.items, 'update').mockResolvedValue(makeItem());
    const user = userEvent.setup();
    renderDialog(makeItem({ endedAt: '2026-03-31' }));

    await user.clear(screen.getByLabelText(/ended at/i));
    await user.click(screen.getByRole('button', { name: /clear end date/i }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('app-1', { endedAt: null }));
    expect(
      screen.queryByText(/pick the date this allocation stops contributing/i),
    ).not.toBeInTheDocument();
  });
});
