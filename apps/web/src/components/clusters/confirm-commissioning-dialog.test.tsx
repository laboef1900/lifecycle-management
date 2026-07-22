import type { HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ConfirmCommissioningDialog } from './host-dialogs';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-1',
    name: 'esx-01',
    description: null,
    commissionedAt: '2026-07-01',
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
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    capacities: [],
    source: 'vsphere',
    commissionedAtProvisional: true,
    ...overrides,
  };
}

function renderDialog(hosts: HostResponse[], onOpenChange = vi.fn()): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmCommissioningDialog open onOpenChange={onOpenChange} clusterId="cl-1" hosts={hosts} />
    </QueryClientProvider>,
  );
}

describe('<ConfirmCommissioningDialog>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hosts, 'confirmCommissioning').mockResolvedValue([makeHost()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pre-fills each host date with its imported (provisional) date', () => {
    renderDialog([
      makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' }),
      makeHost({ id: 'b', name: 'esx-02', commissionedAt: '2025-01-15' }),
    ]);

    expect(screen.getByLabelText('esx-01')).toHaveValue('2026-07-01');
    expect(screen.getByLabelText('esx-02')).toHaveValue('2025-01-15');
  });

  it('submits per-host dates, sending the adjusted value and the untouched default', async () => {
    const onOpenChange = vi.fn();
    renderDialog(
      [
        makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' }),
        makeHost({ id: 'b', name: 'esx-02', commissionedAt: '2025-01-15' }),
      ],
      onOpenChange,
    );

    fireEvent.change(screen.getByLabelText('esx-01'), { target: { value: '2020-03-01' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm 2 dates' }));

    await waitFor(() => {
      expect(api.hosts.confirmCommissioning).toHaveBeenCalledWith({
        hosts: [
          { hostId: 'a', commissionedAt: '2020-03-01' },
          { hostId: 'b', commissionedAt: '2025-01-15' },
        ],
      });
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirm-as-is: submitting without changing a date still confirms it', async () => {
    renderDialog([makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' })]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm date' }));

    await waitFor(() => {
      expect(api.hosts.confirmCommissioning).toHaveBeenCalledWith({
        hosts: [{ hostId: 'a', commissionedAt: '2026-07-01' }],
      });
    });
  });

  it('blocks submit with an inline error when a date is cleared', async () => {
    renderDialog([makeHost({ id: 'a', name: 'esx-01' })]);

    const input = screen.getByLabelText('esx-01');
    // The native `required` attribute blocks submit before our Zod layer runs;
    // drop it so the schema-driven validation path is the one under test.
    input.removeAttribute('required');
    fireEvent.change(input, { target: { value: '' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm date' }));

    // The invalid date maps to that row's field-error slot (aria-invalid), not a
    // fallback toast, and the request is never sent.
    await waitFor(() => {
      expect(screen.getByLabelText('esx-01')).toHaveAttribute('aria-invalid', 'true');
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.hosts.confirmCommissioning).not.toHaveBeenCalled();
  });

  it('moves focus to the invalid row on a blocked submit', async () => {
    renderDialog([makeHost({ id: 'a', name: 'esx-01' }), makeHost({ id: 'b', name: 'esx-02' })]);

    const input = screen.getByLabelText('esx-02');
    input.removeAttribute('required');
    fireEvent.change(input, { target: { value: '' } });
    screen.getByRole('button', { name: 'Confirm 2 dates' }).focus();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm 2 dates' }));

    await waitFor(() => expect(input).toHaveFocus());
  });

  it('omits the "set all" field for a single host (redundant with its own row)', () => {
    renderDialog([makeHost({ id: 'a', name: 'esx-01' })]);

    expect(screen.queryByLabelText('Set all dates')).not.toBeInTheDocument();
    expect(screen.getByLabelText('esx-01')).toBeInTheDocument();
  });

  it('"set all" fills every host row with the chosen date', () => {
    renderDialog([
      makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' }),
      makeHost({ id: 'b', name: 'esx-02', commissionedAt: '2025-01-15' }),
    ]);

    fireEvent.change(screen.getByLabelText('Set all dates'), { target: { value: '2021-06-30' } });

    expect(screen.getByLabelText('esx-01')).toHaveValue('2021-06-30');
    expect(screen.getByLabelText('esx-02')).toHaveValue('2021-06-30');
  });

  it('submits a "set all" date applied to every host', async () => {
    renderDialog([
      makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' }),
      makeHost({ id: 'b', name: 'esx-02', commissionedAt: '2025-01-15' }),
    ]);

    fireEvent.change(screen.getByLabelText('Set all dates'), { target: { value: '2021-06-30' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm 2 dates' }));

    await waitFor(() => {
      expect(api.hosts.confirmCommissioning).toHaveBeenCalledWith({
        hosts: [
          { hostId: 'a', commissionedAt: '2021-06-30' },
          { hostId: 'b', commissionedAt: '2021-06-30' },
        ],
      });
    });
  });

  it('keeps individual rows editable after a "set all" bulk apply', async () => {
    renderDialog([
      makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' }),
      makeHost({ id: 'b', name: 'esx-02', commissionedAt: '2025-01-15' }),
    ]);

    // Bulk-apply one date, then correct a single exception row.
    fireEvent.change(screen.getByLabelText('Set all dates'), { target: { value: '2021-06-30' } });
    fireEvent.change(screen.getByLabelText('esx-02'), { target: { value: '2019-11-05' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm 2 dates' }));

    await waitFor(() => {
      expect(api.hosts.confirmCommissioning).toHaveBeenCalledWith({
        hosts: [
          { hostId: 'a', commissionedAt: '2021-06-30' },
          { hostId: 'b', commissionedAt: '2019-11-05' },
        ],
      });
    });
  });

  it('clearing the "set all" field does not blank the host rows', () => {
    renderDialog([
      makeHost({ id: 'a', name: 'esx-01', commissionedAt: '2026-07-01' }),
      makeHost({ id: 'b', name: 'esx-02', commissionedAt: '2025-01-15' }),
    ]);

    const bulk = screen.getByLabelText('Set all dates');
    fireEvent.change(bulk, { target: { value: '2021-06-30' } });
    fireEvent.change(bulk, { target: { value: '' } });

    // Rows keep the last applied value instead of being wiped to empty.
    expect(screen.getByLabelText('esx-01')).toHaveValue('2021-06-30');
    expect(screen.getByLabelText('esx-02')).toHaveValue('2021-06-30');
  });

  it('"set all" clears a stale inline error on the rows it overwrites', async () => {
    renderDialog([makeHost({ id: 'a', name: 'esx-01' }), makeHost({ id: 'b', name: 'esx-02' })]);

    // Force an inline error on one row via a blocked submit.
    const rowA = screen.getByLabelText('esx-01');
    rowA.removeAttribute('required');
    fireEvent.change(rowA, { target: { value: '' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm 2 dates' }));
    await waitFor(() => expect(rowA).toHaveAttribute('aria-invalid', 'true'));

    // Applying a bulk date overwrites every row and drops the stale error.
    fireEvent.change(screen.getByLabelText('Set all dates'), { target: { value: '2021-06-30' } });

    await waitFor(() => expect(rowA).not.toHaveAttribute('aria-invalid'));
    expect(rowA).toHaveValue('2021-06-30');
  });
});
