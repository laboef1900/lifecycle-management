import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { BulkShiftDatesDialog } from './bulk-shift-dates-dialog';

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

function renderDialog(items: ItemResponse[] = [makeItem()]): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <BulkShiftDatesDialog
        open
        onOpenChange={vi.fn()}
        clusterId="cl-1"
        items={items}
        onApplied={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return container;
}

/**
 * Submits the form directly. The Apply button is disabled while the amount is
 * invalid, so a click cannot reach the handler — and the point of these tests is
 * that the *handler* is the gate now that `noValidate` has retired the browser's
 * bubble, not that a disabled button happens to hide it.
 */
function submitForm(): void {
  const form = document.querySelector('form');
  if (form === null) throw new Error('expected the shift-dates form to be rendered');
  fireEvent.submit(form);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<BulkShiftDatesDialog>', () => {
  it("refuses a blank amount with the app's own error, focuses it, and sends nothing", async () => {
    const shift = vi
      .spyOn(api.items, 'bulkShiftDates')
      .mockResolvedValue({ shifted: 1, items: [] });
    const user = userEvent.setup();
    renderDialog();

    const amount = screen.getByLabelText(/amount/i);
    await user.clear(amount);

    expect(screen.getByText(/enter a whole number of 1 or more/i)).toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount).toHaveAccessibleDescription(/enter a whole number of 1 or more/i);
    expect(screen.getByRole('button', { name: /shift 1 entry/i })).toBeDisabled();

    submitForm();

    // SC 3.3.1 — a rejected submit puts the user on the offending control.
    await waitFor(() => expect(amount).toHaveFocus());
    expect(shift).not.toHaveBeenCalled();
  });

  it('refuses an over-cap amount and never sends it (the shared cap is the authority)', async () => {
    const shift = vi
      .spyOn(api.items, 'bulkShiftDates')
      .mockResolvedValue({ shifted: 1, items: [] });
    const user = userEvent.setup();
    renderDialog();

    const amount = screen.getByLabelText(/amount/i);
    await user.clear(amount);
    // MAX_SHIFT_BY_UNIT.months is 120; the default unit is months.
    await user.type(amount, '121');

    expect(screen.getByText(/at most 120 months/i)).toBeInTheDocument();
    submitForm();

    await waitFor(() => expect(amount).toHaveFocus());
    expect(shift).not.toHaveBeenCalled();
  });

  it('submits a valid shift', async () => {
    const shift = vi
      .spyOn(api.items, 'bulkShiftDates')
      .mockResolvedValue({ shifted: 1, items: [] });
    const user = userEvent.setup();
    renderDialog();

    const amount = screen.getByLabelText(/amount/i);
    await user.clear(amount);
    await user.type(amount, '3');
    await user.click(screen.getByRole('button', { name: /shift 1 entry/i }));

    await waitFor(() =>
      expect(shift).toHaveBeenCalledWith(
        { itemIds: ['app-1'], shift: { amount: 3, unit: 'months' } },
        expect.any(String),
      ),
    );
  });
});
