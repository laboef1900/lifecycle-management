import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { CreateClusterDialog } from './create-cluster-dialog';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderDialog(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CreateClusterDialog />
    </QueryClientProvider>,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '+ Add cluster' }));
}

describe('CreateClusterDialog validation', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'create').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an empty name and does not call the API', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    // No `removeAttribute('required')` crutch: the form sets `noValidate`, so the
    // click reaches the submit handler and the app's own error is what an operator
    // actually sees. If that opt-out regresses, this test fails.
    const nameInput = screen.getByRole('textbox', { name: 'Name' });

    await user.click(screen.getByRole('button', { name: 'Create cluster' }));

    expect(api.clusters.create).not.toHaveBeenCalled();
    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(
      document.getElementById(nameInput.getAttribute('aria-describedby') ?? ''),
    ).toBeInTheDocument();
  });

  it('moves focus to the invalid name field on a blocked submit', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    const submit = screen.getByRole('button', { name: 'Create cluster' });
    submit.focus();
    await user.click(submit);

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus());
  });

  it('rejects a cleared baseline instead of posting it as 0', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'CL-Unit-1');
    // `Number('')` is 0 and the shared `positiveAmount` accepts 0, so without the
    // blank guard a cleared capacity would post a real "this cluster has 0 GB".
    const capacity = screen.getByRole('spinbutton', { name: 'Capacity (GB)' });
    await user.clear(capacity);

    await user.click(screen.getByRole('button', { name: 'Create cluster' }));

    await waitFor(() => expect(capacity).toHaveAttribute('aria-invalid', 'true'));
    expect(
      document.getElementById(capacity.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Enter a value');
    expect(api.clusters.create).not.toHaveBeenCalled();
  });

  it('calls api.clusters.create with the wire payload on valid input', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'CL-Unit-1');
    await user.clear(screen.getByRole('spinbutton', { name: 'Consumption (GB)' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Consumption (GB)' }), '100');
    await user.clear(screen.getByRole('spinbutton', { name: 'Capacity (GB)' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Capacity (GB)' }), '500');

    await user.click(screen.getByRole('button', { name: 'Create cluster' }));

    expect(api.clusters.create).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(api.clusters.create).mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      name: 'CL-Unit-1',
      baselineDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 500 }],
    });
  });
});
