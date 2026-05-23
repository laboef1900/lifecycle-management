import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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

    // Required attribute on the native input fires first — clear required and submit
    // by removing the attribute to ensure our Zod refine layer also catches it.
    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    nameInput.removeAttribute('required');

    await user.click(screen.getByRole('button', { name: 'Create cluster' }));

    expect(api.clusters.create).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 1 character/i)).toBeInTheDocument();
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
