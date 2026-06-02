import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { EditItemDialog } from './item-dialogs';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeApplication(): ItemResponse {
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
    allocations: [
      {
        id: 'alloc-1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        effectiveFrom: '2026-01-15',
        amount: 512,
      },
    ],
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
}

function renderEditDialog(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EditItemDialog open onOpenChange={vi.fn()} clusterId="cl-1" item={makeApplication()} />
    </QueryClientProvider>,
  );
}

describe('<EditItemDialog> validation', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([
      { id: 'c1', name: 'OpenShift' },
      { id: 'c2', name: 'Growth' },
    ]);
    vi.spyOn(api.items, 'update').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks submit with an inline error when the name is empty', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    // The native `required` attribute fires before our Zod layer; drop it so the
    // schema-driven validation path is the one under test.
    nameInput.removeAttribute('required');
    await user.clear(nameInput);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/at least 1 character/i)).toBeInTheDocument();
    expect(api.items.update).not.toHaveBeenCalled();
  });
});
