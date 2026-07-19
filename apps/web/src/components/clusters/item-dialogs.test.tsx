import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { CreateItemDialog, EditItemDialog } from './item-dialogs';

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

    expect(await screen.findByText(/too small/i)).toBeInTheDocument();
    expect(api.items.update).not.toHaveBeenCalled();
  });

  it('moves focus to the Name field on a failed submit', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    nameInput.removeAttribute('required');
    await user.clear(nameInput);
    screen.getByRole('button', { name: 'Save' }).focus();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(nameInput).toHaveFocus());
  });
});

describe('<CreateItemDialog> invalidation', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([{ id: 'c1', name: 'OpenShift' }]);
    vi.spyOn(api.items, 'create').mockResolvedValue(makeApplication());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidates the cluster and clusters queries after a successful create', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['cluster', 'cl-1'], {});
    client.setQueryData(['clusters'], []);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <CreateItemDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
      </QueryClientProvider>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'openshift-lab');
    await user.type(screen.getByLabelText('Category'), 'OpenShift');
    await user.click(screen.getByRole('button', { name: /add application/i }));

    await waitFor(() => {
      expect(client.getQueryState(['cluster', 'cl-1'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['clusters'])?.isInvalidated).toBe(true);
    });
  });
});
